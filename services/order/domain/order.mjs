import { AppError } from '../../../common/errors.mjs';

export const ACTIVE = ['MATCHING', 'ASSIGNING', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'];
export const TERMINAL = ['COMPLETED', 'CANCELLED', 'FAILED'];
const conflict = (code, message) => { throw new AppError(409, code, message); };

// Order is the aggregate root. No database, network call, or timer lives here.
export class Order {
  constructor(snapshot) { this.data = structuredClone(snapshot); }
  static create({ id, riderId, estimate, at }) {
    return new Order({
      id, rider_id: riderId, status: 'MATCHING', version: 1,
      origin: estimate.origin, destination: estimate.destination, estimate,
      driver_id: null, pending_driver_id: null, offer_id: null, assignment_id: null,
      created_at: at, updated_at: at, accepted_at: null, arrived_at: null,
      started_at: null, finished_at: null, cancelled_at: null,
      final_distance_m: null, final_amount_cents: null, failure_reason: null,
    });
  }
  touch(at) { this.data.version++; this.data.updated_at = at; }
  assertRider(id) {
    if (this.data.rider_id !== id) throw new AppError(403, 'NOT_YOUR_ORDER', '只能操作自己的订单');
  }
  assertDriver(id) {
    if (this.data.driver_id !== id) throw new AppError(403, 'NOT_YOUR_ORDER', '只能处理自己承接的订单');
  }
  beginAssignment(driverId, offerId, assignmentId, at) {
    const d = this.data;
    if (d.driver_id === driverId && d.offer_id === offerId && ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED'].includes(d.status)) return false;
    if (d.status === 'ASSIGNING' && d.pending_driver_id === driverId && d.offer_id === offerId) return false;
    if (d.status !== 'MATCHING') conflict('ORDER_UNAVAILABLE', '订单已被接单、取消，或正在确认其他司机');
    d.status = 'ASSIGNING'; d.pending_driver_id = driverId; d.offer_id = offerId; d.assignment_id = assignmentId;
    this.touch(at); return true;
  }
  confirmAssignment(assignmentId, at) {
    const d = this.data;
    if (d.status !== 'ASSIGNING' || d.assignment_id !== assignmentId) return false;
    d.status = 'ACCEPTED'; d.driver_id = d.pending_driver_id; d.pending_driver_id = null; d.accepted_at = at;
    this.touch(at); return true;
  }
  rejectAssignment(assignmentId, reason, at) {
    const d = this.data;
    if (d.status !== 'ASSIGNING' || d.assignment_id !== assignmentId) return false;
    d.status = 'MATCHING'; d.pending_driver_id = null; d.assignment_id = null; d.offer_id = null;
    d.last_assignment_failure = reason; this.touch(at); return true;
  }
  cancel(riderId, at) {
    this.assertRider(riderId); const d = this.data;
    if (d.status === 'CANCELLED') return false;
    if (d.status === 'IN_PROGRESS' || d.started_at) conflict('TRIP_ALREADY_STARTED', '行程已开始，不能普通取消');
    if (!ACTIVE.includes(d.status)) conflict('INVALID_STATE', '当前订单状态不允许取消');
    d.status = 'CANCELLED'; d.cancelled_at = at; this.touch(at); return true;
  }
  arrive(driverId, at) {
    this.assertDriver(driverId); const d = this.data;
    if (d.arrived_at) return false;
    if (d.status !== 'ACCEPTED') conflict('INVALID_STATE', '只有已接单的行程可以确认到达');
    d.status = 'ARRIVED'; d.arrived_at = at; this.touch(at); return true;
  }
  start(driverId, at) {
    this.assertDriver(driverId); const d = this.data;
    if (d.started_at) return false;
    if (d.status !== 'ARRIVED') conflict('INVALID_STATE', '请先确认到达上车点，再开始行程');
    d.status = 'IN_PROGRESS'; d.started_at = at; this.touch(at); return true;
  }
  finish(driverId, fare, at) {
    this.assertDriver(driverId); const d = this.data;
    if (d.status === 'COMPLETED') return false;
    if (d.status !== 'IN_PROGRESS') conflict('INVALID_STATE', '只有进行中的行程可以结束');
    if (!Number.isInteger(fare.distance_m) || fare.distance_m <= 0 || fare.distance_m > 200000 || !Number.isInteger(fare.amount_cents) || fare.amount_cents < 0) {
      throw new AppError(400, 'INVALID_FARE', '里程或费用无效');
    }
    d.status = 'COMPLETED'; d.finished_at = at;
    d.final_distance_m = fare.distance_m; d.final_amount_cents = fare.amount_cents;
    this.touch(at); return true;
  }
  failMatching(reason, at) {
    if (this.data.status === 'FAILED') return false;
    if (this.data.status !== 'MATCHING') conflict('ORDER_UNAVAILABLE', '订单已进入其他阶段，不能结束匹配');
    this.data.status = 'FAILED'; this.data.failure_reason = reason; this.touch(at); return true;
  }
}
