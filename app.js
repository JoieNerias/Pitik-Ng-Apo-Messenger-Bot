
const http = require("http");

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL = "gemini-3.8-flash";

const SYSTEM_PROMPT = `
Ikaw ang friendly at professional na AI customer service assistant
ng Pitik ng Apo, isang photography service.

Mga patakaran:
- Sumagot nang magalang, natural at madaling maintindihan.
- Gumamit ng Filipino o Taglish depende sa wika ng customer.
- Maging helpful, warm at professional.
- Tumulong sa inquiries tungkol sa photography at event coverage.
- Magtanong ng event type, date, venue at contact details kung kailangan.
- Huwag mag-imbento ng presyo, packages, availability o services.
- Kung walang sapat na impormasyon, sabihin na ipa-confirm ito
  sa Pitik ng Apo team.
- Huwag mangako ng booking confirmation.
- Panatilihing maikli at madaling basahin ang replies.
`;

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
        
        console.log("MESSENGER WEBHOOK RECEIVED:", JSON.stringify(data));

        if (data.object !== "page") return;

        for (const entry of data.entry || []) {
          for (const event of entry.messaging || []) {

            if (
              event.message &&
              event.message.text &&
              !event.message.is_echo
            ) {
              const customerMessage = event.message.text;
              const senderId = event.sender.id;

              const aiReply = await generateGeminiReply(
                customerMessage
              );

              await sendReply(senderId, aiReply);
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


// Generate AI response using Google Gemini
async function generateGeminiReply(customerMessage) {

  if (!GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is missing.");
    return "Pasensya na po. May technical issue kami ngayon. Please try again later.";
  }

  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: customerMessage }]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 300
        }
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", JSON.stringify(result));
      return "Pasensya na po. Hindi muna ako makasagot ngayon. Maaari po ba kayong mag-message ulit mamaya?";
    }

    const reply =
      result.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

    if (!reply) {
      console.error("Gemini returned an empty response.");
      return "Pasensya na po. Hindi ko po naintindihan ang inyong message. Maaari po bang ulitin?";
    }

    return reply;

  } catch (error) {
    console.error("Gemini connection error:", error.message);
    return "Pasensya na po. May connection issue kami ngayon. Please try again later.";
  }
}


// Send reply to Facebook Messenger
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
      headers: {
        "Content-Type": "application/json"
      },
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
