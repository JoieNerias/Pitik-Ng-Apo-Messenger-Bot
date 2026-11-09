const http = require("http");

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION;

const server = http.createServer(async (req, res) => {
  // Meta webhook verification
  if (req.method === "GET" && req.url.startsWith("/webhook")) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(challenge);
    }

    res.writeHead(403);
    return res.end("Verification failed");
  }

  // Receive Messenger messages
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("EVENT_RECEIVED");

      try {
        const data = JSON.parse(body);

        if (data.object !== "page") return;

        for (const entry of data.entry || []) {
          for (const event of entry.messaging || []) {
            if (
              event.message &&
              event.message.text &&
              !event.message.is_echo
            ) {
              await sendReply(
                event.sender.id,
                "Hello po! 👋 Thank you for messaging Pitik ng Apo! 📸"
              );
            }
          }
        }
      } catch (error) {
        console.error("Webhook error:", error.message);
      }
    });

    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Pitik ng Apo Messenger Bot is running.");
});

async function sendReply(recipientId, messageText) {
  if (!PAGE_ACCESS_TOKEN || !GRAPH_API_VERSION) {
    console.error("Messenger environment settings are incomplete.");
    return;
  }

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages`;

  const response = await fetch(
    `${url}?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text: messageText }
      })
    }
  );

  if (!response.ok) {
    console.error("Messenger API error:", await response.text());
  }
}

server.listen(PORT, () => {
  console.log(`Pitik ng Apo Bot running on port ${PORT}`);
});
