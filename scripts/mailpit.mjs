// Reads e-mails captured by Mailpit (local/CI only). Used by e2e tests and the demo seed
// to follow links exactly as a user would.
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

/** Waits for the newest message to `to` whose subject contains `subject`; returns its first link. */
export async function latestLink(to, subject, { timeoutMs = 15_000, after = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const q = encodeURIComponent(`to:"${to}"`);
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${q}&limit=20`);
    if (res.ok) {
      const { messages = [] } = await res.json();
      const hit = messages.find(
        (m) => m.Subject.includes(subject) && new Date(m.Created).getTime() >= after,
      );
      if (hit) {
        const msg = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
        const link = msg.Text.match(/https?:\/\/\S+/)?.[0];
        if (link) return link;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No e-mail "${subject}" to ${to} within ${timeoutMs} ms (is Mailpit running?)`);
}
