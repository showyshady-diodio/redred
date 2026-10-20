export async function onRequest({ request, env, next }) {
  if (new URL(request.url).pathname.startsWith("/api/") && !env.DB) {
    return Response.json(
      { error: "D1 binding DB is missing. Start Pages dev with --d1=DB=<database-id>." },
      { status: 503 },
    );
  }
  return next();
}
