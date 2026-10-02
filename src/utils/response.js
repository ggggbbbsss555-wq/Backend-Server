// Standard JSON response helpers. All routes use these so the API shape is
// uniform: { ok: true, data: ... } or { ok: false, error: { code, message } }.

export function ok(res, data = null, status = 200) {
  return res.status(status).json({ ok: true, data });
}

export function created(res, data) {
  return ok(res, data, 201);
}

export function fail(res, { code = 'INTERNAL', message = 'Something went wrong', status = 500, details } = {}) {
  return res.status(status).json({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

export function failBadRequest(res, message = 'Bad request', details) {
  return fail(res, { code: 'BAD_REQUEST', message, status: 400, details });
}

export function failUnauthorized(res, message = 'Unauthorized') {
  return fail(res, { code: 'UNAUTHORIZED', message, status: 401 });
}

export function failForbidden(res, message = 'Forbidden') {
  return fail(res, { code: 'FORBIDDEN', message, status: 403 });
}

export function failNotFound(res, message = 'Not found') {
  return fail(res, { code: 'NOT_FOUND', message, status: 404 });
}
