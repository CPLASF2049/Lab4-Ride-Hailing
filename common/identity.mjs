import { randomUUID } from 'node:crypto';

export const uid = (prefix = 'id') => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
