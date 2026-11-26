import { createHash } from 'node:crypto';
import { uid, now } from '../../../common/identity.mjs';
import { AppError as HttpError } from '../../../common/errors.mjs';
import { log } from '../../../common/log.mjs';
import { Order } from '../domain/order.mjs';
const hashRequest = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');

export const releaseJob = d => ({
  id: `release:${d.assignment_id}`, type: 'RELEASE_DRIVER', order_id: d.id,
  payload: { driver_id: d.driver_id || d.pending_driver_id, order_id: d.id, assignment_id: d.assignment_id },
});
const resolveJob = (d, status) => ({
  id: `resolve:${d.assignment_id}:${status}`, type: 'RESOLVE_OFFER', order_id: d.id,
  payload: { offer_id: d.offer_id, assignment_id: d.assignment_id, status },
});

export class OrderApplication {
  constructor({ repository, clients, clock = now }) {
    this.repo = repository; this.clients = clients; this.clock = clock; this.runningJobs = new Set();
  }
  async create(riderId, body, key) {
    if (typeof key !== 'string' || !/^[\w-]{8,128}$/.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', '叫车请求需要 8–128 位请求标识');
    if (typeof body.estimate_id !== 'string') throw new HttpError(400, 'ESTIMATE_REQUIRED', '请先获取预估报价');
    const hash = hashRequest({ estimate_id: body.estimate_id });
    const replay = this.repo.findRequest(riderId, key, hash);
    if (replay) return replay;
    const { estimate } = await this.clients.getEstimate(body.estimate_id);
    if (estimate.rider_id !== riderId) throw new HttpError(403, 'NOT_YOUR_ESTIMATE', '只能使用自己的报价');
    if (!Number.isFinite(Date.parse(estimate.expires_at)) || Date.parse(estimate.expires_at) <= Date.parse(this.clock())) throw new HttpError(409, 'ESTIMATE_EXPIRED', '报价已过期，请重新获取预估');
    const root = Order.create({ id: uid('ord'), riderId, estimate, at: this.clock() });
    return this.repo.create(root, key, hash);
  }
  async accept(orderId, { driver_id: driverId, offer_id: offerId }) {
    let current = this.repo.get(orderId);
    if (current.offer_id === offerId && (current.driver_id === driverId || current.pending_driver_id === driverId) && ['ASSIGNING','ACCEPTED','ARRIVED','IN_PROGRESS','COMPLETED'].includes(current.status)) {
      if (current.status === 'ASSIGNING') await this.runJob(`reserve:${current.assignment_id}`);
      return this.repo.get(orderId);
    }
    if (current.status !== 'MATCHING') throw new HttpError(409, 'ORDER_UNAVAILABLE', '订单已取消、失败或已被接单');
    const { offer } = await this.clients.getOffer(offerId);
    if (offer.order_id !== orderId || offer.driver_id !== driverId) throw new HttpError(403, 'NOT_YOUR_OFFER', '派单不属于当前司机或订单');
    if (offer.status !== 'PENDING' || Date.parse(offer.expires_at) <= Date.parse(this.clock())) throw new HttpError(409, 'OFFER_EXPIRED', '派单已失效，请刷新列表');
    const assignmentId = uid('asg');
    current = this.repo.change(orderId, root => {
      const changed = root.beginAssignment(driverId, offerId, assignmentId, this.clock());
      return changed ? [{ id: `reserve:${assignmentId}`, type: 'RESERVE_DRIVER', order_id: orderId, payload: { driver_id: driverId, offer_id: offerId, assignment_id: assignmentId, order_id: orderId } }] : [];
    });
    await this.runJob(`reserve:${current.assignment_id}`);
    return this.repo.get(orderId);
  }
  cancel(orderId, riderId) {
    return this.repo.change(orderId, root => {
      const changed = root.cancel(riderId, this.clock());
      return changed && root.data.assignment_id ? [releaseJob(root.data)] : [];
    });
  }
  arrive(orderId, driverId) { return this.repo.change(orderId, root => { root.arrive(driverId, this.clock()); }); }
  start(orderId, driverId) { return this.repo.change(orderId, root => { root.start(driverId, this.clock()); }); }
  async finish(orderId, driverId, body) {
    const root = new Order(this.repo.get(orderId)); root.assertDriver(driverId);
    if (root.data.status === 'COMPLETED') return root.data;
    if (root.data.status !== 'IN_PROGRESS') throw new HttpError(409, 'INVALID_STATE', '只有进行中的行程可以结束');
    const distance = body.distance_m ?? root.data.estimate.distance_m;
    if (!Number.isInteger(distance) || distance <= 0 || distance > 200000) throw new HttpError(400, 'INVALID_DISTANCE', '模拟里程须为 1–200000 米之间的整数');
    const fare = await this.clients.calculateFare({ estimate_id: root.data.estimate.id, distance_m: distance });
    return this.repo.change(orderId, current => {
      const changed = current.finish(driverId, fare, this.clock());
      return changed ? [releaseJob(current.data)] : [];
    });
  }
  failMatching(orderId, reason) {
    if (!['NO_DRIVER','ALL_REJECTED','MATCH_TIMEOUT','ALL_UNAVAILABLE'].includes(reason)) throw new HttpError(400, 'INVALID_REASON', '匹配失败原因无效');
    return this.repo.change(orderId, root => { root.failMatching(reason, this.clock()); });
  }
  async runJob(id) {
    if (this.runningJobs.has(id)) return;
    const job = this.repo.findPendingJob(id);
    if (!job) return;
    this.runningJobs.add(id);
    try {
      const payload = JSON.parse(job.payload);
      if (job.type === 'RESERVE_DRIVER') await this.assign(job, payload);
      else if (job.type === 'RELEASE_DRIVER') { await this.clients.releaseDriver(payload); this.repo.finishJob(job.id); }
      else if (job.type === 'RESOLVE_OFFER') {
        try { await this.clients.resolveOffer(payload); }
        catch (error) { if (![404,409,410].includes(error.status)) throw error; }
        this.repo.finishJob(job.id);
      }
      log('order', 'job_done', { order_id: job.order_id, job_id: job.id, type: job.type });
    } catch (error) {
      this.repo.retryJob(job, error);
      log('order', 'job_retry', { order_id: job.order_id, job_id: job.id, code: error.code || error.message, attempt: job.attempts + 1 });
    } finally { this.runningJobs.delete(id); }
  }
  async assign(job, payload) {
    let current = this.repo.get(job.order_id);
    if (current.status !== 'ASSIGNING' || current.assignment_id !== payload.assignment_id) {
      this.repo.change(job.order_id, () => {
        this.repo.finishJob(job.id);
        return current.assignment_id === payload.assignment_id && ['ACCEPTED','ARRIVED','IN_PROGRESS','COMPLETED'].includes(current.status)
          ? [resolveJob({ ...payload, id: job.order_id }, 'ACCEPTED')]
          : [releaseJob({ ...payload, id: job.order_id })];
      }); return;
    }
    try {
      await this.clients.claimOffer(payload);
      // The driver is the authority for online status and exclusive occupation.
      await this.clients.reserveDriver(payload);
    } catch (error) {
      if (![400,403,404,409,410].includes(error.status)) throw error;
      this.repo.change(job.order_id, root => {
        root.rejectAssignment(payload.assignment_id, error.code, this.clock());
        this.repo.finishJob(job.id);
        return [releaseJob({ ...payload, id: job.order_id }), resolveJob({ ...payload, id: job.order_id }, 'FAILED')];
      }); return;
    }
    this.repo.change(job.order_id, root => {
      const changed = root.confirmAssignment(payload.assignment_id, this.clock());
      this.repo.finishJob(job.id);
      return changed ? [resolveJob({ ...payload, id: job.order_id }, 'ACCEPTED')] : [releaseJob({ ...payload, id: job.order_id })];
    });
  }
}
