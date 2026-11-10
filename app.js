
const http = require("http");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

console.log("Firebase connected successfully!");

// ENVIRONMENT VARIABLES
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v24.0";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Gemini automatic fallback models
const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite"
];

// SYSTEM PROMPT
const SYSTEM_PROMPT = `
Ikaw ang AI assistant ng Pitik ng Apo photography services.

Mga alituntunin:
- Sumagot sa natural, magalang at friendly na Filipino o Taglish.
- Panatilihing maikli, malinaw at madaling maintindihan ang sagot.
- Tulungan ang customer sa kanilang photography inquiries at booking.
- Magtanong nang paisa-isa kung may kulang na detalye.
- Huwag mag-imbento ng package, presyo, schedule, availability, pangalan o contact number ng staff.
- Kung kailangan ng confirmation, sabihin na ipa-check muna sa Pitik ng Apo team.
- Panatilihin ang naunang impormasyon sa conversation.
- Huwag sabihin na confirmed ang booking hangga't hindi ito kinukumpirma ng team.
- Maging professional, helpful at welcoming.
`;

// GET CONVERSATION HISTORY FROM FIRESTORE
async function getConversationHistory(senderId) {
  const snapshot = await db
    .collection("conversations")
    .doc(senderId)
    .collection("messages")
    .orderBy("timestamp", "desc")
    .limit(10)
    .get();

  return snapshot.docs
    .reverse()
    .map(doc => ({
      role: doc.data().role,
      parts: [{ text: doc.data().text }]
    }));
}

// SAVE CONVERSATION MESSAGE
async function saveConversationMessage(senderId, role, text) {
  await db
    .collection("conversations")
    .doc(senderId)
    .collection("messages")
    .add({
      role,
      text,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
}

// DELAY FUNCTION
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CHECK TEMPORARY GEMINI ERRORS
function isTemporaryGeminiError(status) {
  return [
    408,
    404,
    429,
    500,
    502,
    503,
    504
  ].includes(status);
}

// GEMINI AI WITH AUTOMATIC MODEL FALLBACK
async function generateGeminiReply(conversationHistory) {

  for (const model of GEMINI_MODELS) {

    console.log("Trying Gemini model:", model);

    for (let attempt = 1; attempt <= 2; attempt++) {

      try {

        const controller = new AbortController();

        const timeout = setTimeout(
          () => controller.abort(),
          20000
        );

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": GEMINI_API_KEY
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: SYSTEM_PROMPT }]
              },
              contents: conversationHistory,
              generationConfig: {
                maxOutputTokens: 200
              }
            }),
            signal: controller.signal
          }
        );

        clearTimeout(timeout);

        if (!response.ok) {

          const errorText = await response.text();

          console.error(
            `Gemini ${model} error (${response.status}):`,
            errorText
          );

          if (isTemporaryGeminiError(response.status)) {
            break;
          }

          return "Pasensya na po, may pansamantalang problema sa aming AI assistant. Maaari po ba kayong mag-message muli mamaya?";
        }

        const data = await response.json();

        const reply =
          data.candidates?.[0]?.content?.parts
            ?.map(part => part.text || "")
            .join("")
            .trim();

        if (reply) {
          console.log("Gemini response successful using:", model);
          return reply;
        }

        console.log("No usable response from:", model);
        break;

      } catch (error) {

        console.error(
          `Gemini ${model} attempt ${attempt} failed:`,
          error.message
        );

        if (attempt < 2) {
          await delay(2000);
        }
      }
    }
  }

  console.error("All Gemini models failed.");

  return "Pasensya na po, hindi muna namin makuha ang sagot sa ngayon. Pakisubukan po ulit mamaya. Maraming salamat sa inyong pang-unawa! 😊";
}

// SEND MESSAGE TO FACEBOOK MESSENGER
async function sendReply(senderId, message) {

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient: {
        id: senderId
      },
      message: {
        text: message
      }
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("Messenger send error:", result);
  }

  return result;
}

// HTTP SERVER
const server = http.createServer(async (req, res) => {

  // META WEBHOOK VERIFICATION
  if (req.method === "GET" && req.url.startsWith("/webhook")) {

    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified successfully!");
      res.writeHead(200);
      return res.end(challenge);
    }

    res.writeHead(403);
    return res.end("Verification failed");
  }

  // RECEIVE MESSENGER WEBHOOK
  if (req.method === "POST" && req.url === "/webhook") {

    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", async () => {

      try {

        const data = JSON.parse(body);

        console.log(
          "MESSENGER WEBHOOK RECEIVED:",
          JSON.stringify(data)
        );

        // Acknowledge Meta immediately
        res.writeHead(200);
        res.end("EVENT_RECEIVED");

        if (data.object !== "page") {
          return;
        }

        for (const entry of data.entry || []) {

          for (const event of entry.messaging || []) {

            if (
              event.message &&
              event.message.text &&
              !event.message.is_echo
            ) {

              const senderId = event.sender.id;
              const userMessage = event.message.text;

              // Immediate acknowledgement
              await sendReply(
                senderId,
                "Salamat po sa inyong message! Sandali lang po habang inihahanda namin ang aming sagot. Salamat sa inyong pang-unawa. 😊"
              );

              // Save user message
              await saveConversationMessage(
                senderId,
                "user",
                userMessage
              );

              // Retrieve conversation history
              const history =
                await getConversationHistory(senderId);

              // Generate AI reply
              const aiReply =
                await generateGeminiReply(history);

              // Save AI response
              await saveConversationMessage(
                senderId,
                "model",
                aiReply
              );

              // Send AI reply
              await sendReply(
                senderId,
                aiReply
              );
            }
          }
        }

      } catch (error) {

        console.error(
          "Webhook processing error:",
          error
        );

      }
    });

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// START SERVER
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(
    `Pitik ng Apo Bot running on port ${PORT}`
  );
});
