// [[path]].js
import { handleUpdate } from '../main.js';

export async function onRequest(context) {
  const { request, env, waitUntil } = context;

  if (request.method === "POST") {
    try {
      const update = await request.json();
      await handleUpdate(update, env, { waitUntil });
      return new Response("ok");
    } catch (err) {
      return new Response("bad request", { status: 400 });
    }
  }

  // برای GET یا هر چیز دیگه
  return new Response("Bot is running");
}
