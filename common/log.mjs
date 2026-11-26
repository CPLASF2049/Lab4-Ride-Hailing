export function log(service, action, details = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), service, action, ...details }));
}
