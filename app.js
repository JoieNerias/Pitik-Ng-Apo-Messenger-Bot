
const http = require("http");
const admin = require("firebase-admin");

// ==========================================
// 1. FIREBASE INITIALIZATION
// ==========================================

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT is missing!");
}

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

console.log("[FIREBASE] Connected successfully!");

// ==========================================
// 2. ENVIRONMENT VARIABLES
// ==========================================

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v24.0";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const PORT = process.env.PORT || 10000;

if (!VERIFY_TOKEN) console.error("[CONFIG] VERIFY_TOKEN is missing!");
if (!PAGE_ACCESS_TOKEN) console.error("[CONFIG] PAGE_ACCESS_TOKEN is missing!");
if (!GEMINI_API_KEY) console.error("[CONFIG] GEMINI_API_KEY is missing!");

// ==========================================
// 3. GEMINI MODELS
// ==========================================

const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite"
];

const SYSTEM_PROMPT = `
Ikaw ang AI assistant ng Pitik ng Apo photography services.

Sumagot sa natural, magalang at friendly na Filipino o Taglish.
Maging maikli at malinaw.
Huwag mag-imbento ng presyo, package, availability,
pangalan, contact number o staff details.
Huwag mag-confirm ng booking.
Ang final quotation at schedule ay kailangang kumpirmahin ng team.

AVAILABLE PACKAGES:

Package 1: Birthday / Binyag
₱2,500 for 2 hours.

Package 2: Community / Corporate Events
₱3,500 for 4 hours.

Package 3: Sports Photography - COMING SOON.
Walang confirmed price.

Photo Printing Service - COMING SOON.
Walang confirmed price.

Walang automatic additional-hour pricing.
Ang final quotation ay manggagaling sa Pitik ng Apo team.

Digital photo delivery:
Google Drive o Pitik ng Apo Facebook Page.
Allow 2–3 days processing after the event.

Lahat ng booking ay inquiry lamang at hindi confirmed
hanggang makumpirma ng Pitik ng Apo team.
`;

// ==========================================
// 4. PACKAGE INFORMATION
// ==========================================

const PACKAGES = {
  "1": {
    name: "Birthday / Binyag",
    price: 2500,
    includedHours: 2
  },
  "2": {
    name: "Community / Corporate Events",
    price: 3500,
    includedHours: 4
  }
};

const PACKAGE_MENU = `
📸 PITIK NG APO PHOTOGRAPHY PACKAGES

PACKAGE 1 – Birthday / Binyag
₱2,500
2 hours coverage

PACKAGE 2 – Community / Corporate Events
₱3,500
4 hours coverage

PACKAGE 3 – Sports Photography
COMING SOON

PHOTO PRINTING SERVICE
COMING SOON

IMPORTANT:
All prices are subject to change.
Final quotation and schedule are subject to team confirmation.

Digital photo delivery is available through
Google Drive or our Facebook Page.
Allow 2–3 days processing after the event.
`;

// ==========================================
// 5. CONVERSATION MEMORY
// ==========================================

async function getConversationHistory(senderId) {
  const snapshot = await db
    .collection("conversations")
    .doc(senderId)
    .collection("messages")
    .orderBy("timestamp", "desc")
    .limit(10)
    .get();

  return snapshot.docs.reverse().map(doc => ({
    role: doc.data().role,
    parts: [{ text: doc.data().text }]
  }));
}

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

// ==========================================
// 6. BOOKING SESSION
// ==========================================

function getSessionRef(senderId) {
  return db.collection("bookingSessions").doc(senderId);
}

async function getBookingSession(senderId) {
  const snapshot = await getSessionRef(senderId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function saveBookingSession(senderId, session) {
  await getSessionRef(senderId).set(session);
}

async function clearBookingSession(senderId) {
  await getSessionRef(senderId).delete();
}

// ==========================================
// 7. DELAY
// ==========================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// 8. GEMINI RESPONSE
// ==========================================

async function generateGeminiReply(conversationHistory) {
  if (!GEMINI_API_KEY) {
    return "Pasensya na po, hindi muna available ang AI assistant namin. Maaari po kayong mag-message ulit mamaya.";
  }

  for (const model of GEMINI_MODELS) {
    console.log("[GEMINI] Trying model:", model);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();

      const timeout = setTimeout(
        () => controller.abort(),
        20000
      );

      try {
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

          console.error("[GEMINI] API ERROR:", {
            model,
            status: response.status,
            error: errorText
          });

          if ([408, 404, 429, 500, 502, 503, 504].includes(response.status)) {
            break;
          }

          return "Pasensya na po, may pansamantalang problema sa aming AI assistant. Pakisubukan po ulit mamaya.";
        }

        const data = await response.json();

        const reply = data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();

        if (reply) {
          console.log("[GEMINI] Successful response:", model);
          return reply;
        }

        console.error("[GEMINI] Empty response:", model);
        break;

      } catch (error) {
        clearTimeout(timeout);

        console.error("[GEMINI] Request failed:", {
          model,
          attempt,
          error: error.message
        });

        if (attempt < 2) {
          await delay(2000);
        }
      }
    }
  }

  console.error("[GEMINI] All models failed.");

  return "Pasensya na po, hindi muna namin makuha ang sagot sa ngayon. Pakisubukan po ulit mamaya. 😊";
}

// ==========================================
// 9. FACEBOOK MESSENGER SEND REPLY
// ==========================================

async function sendReply(senderId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.error("[MESSENGER] Missing Page Access Token!");
    return { ok: false };
  }

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        recipient: { id: senderId },
        messaging_type: "RESPONSE",
        message: { text: message }
      })
    });

    const rawResult = await response.text();

    let result;

    try {
      result = JSON.parse(rawResult);
    } catch {
      result = rawResult;
    }

    if (!response.ok) {
      console.error("[MESSENGER] SEND FAILED:", {
        status: response.status,
        error: result
      });

      return {
        ok: false,
        status: response.status,
        error: result
      };
    }

    console.log("[MESSENGER] SEND SUCCESS:", {
      status: response.status,
      messageId: result.message_id || "No message ID"
    });

    return {
      ok: true,
      status: response.status
    };

  } catch (error) {
    console.error("[MESSENGER] NETWORK ERROR:", error.message);

    return {
      ok: false,
      error: error.message
    };
  }
}

async function replyAndSave(senderId, message) {
  await saveConversationMessage(senderId, "model", message);
  return await sendReply(senderId, message);
}

// ==========================================
// 10. START BOOKING
// ==========================================

async function startBooking(senderId) {
  const session = {
    active: true,
    stage: "package",
    startedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await saveBookingSession(senderId, session);

  await replyAndSave(
    senderId,
    PACKAGE_MENU +
    "\n\nKung nais ninyong mag-inquire, piliin lamang:\n\n1 - Birthday / Binyag\n2 - Community / Corporate Events\n\nPaalala: Hindi pa available for booking ang Package 3."
  );
}

// ==========================================
// 11. BOOKING PROCESS
// ==========================================

async function handleBooking(senderId, userMessage) {
  const message = userMessage.trim();
  const lower = message.toLowerCase();

  let session = await getBookingSession(senderId);

  // CANCEL
  if (
    ["cancel", "cancel booking", "stop", "hinto", "ayaw na"].includes(lower)
  ) {
    await clearBookingSession(senderId);

    await replyAndSave(
      senderId,
      "Sige po. Kinansela natin ang kasalukuyang booking inquiry. Maaari po kayong mag-message ulit kung nais ninyong mag-inquire. 😊"
    );

    return true;
  }

  if (!session || !session.active) {
    return false;
  }

  // PACKAGE
  if (session.stage === "package") {
    if (message === "3" || lower.includes("sports")) {
      await replyAndSave(
        senderId,
        "Ang Sports Photography po ay COMING SOON pa lamang. Hindi pa ito available for booking. 😊\n\nPara sa available packages, piliin ang Package 1 o Package 2."
      );
      return true;
    }

    if (message === "1" || lower.includes("package 1")) {
      session.package = "1";
    } else if (message === "2" || lower.includes("package 2")) {
      session.package = "2";
    } else {
      await replyAndSave(
        senderId,
        "Pili lamang po ng available package:\n1 - Birthday / Binyag\n2 - Community / Corporate Events"
      );
      return true;
    }

    session.stage = "name";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      `Salamat po! Napili ninyo ang ${PACKAGES[session.package].name}.\n\nAno po ang buong pangalan ninyo?`
    );

    return true;
  }

  // NAME
  if (session.stage === "name") {
    session.name = message;
    session.stage = "eventType";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Salamat po! Ano pong klaseng event ang inyong gaganapin?"
    );

    return true;
  }

  // EVENT TYPE
  if (session.stage === "eventType") {
    session.eventType = message;
    session.stage = "date";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Ano po ang petsa ng inyong event? (Halimbawa: December 15, 2026)"
    );

    return true;
  }

  // DATE
  if (session.stage === "date") {
    session.eventDate = message;
    session.stage = "time";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Anong oras po magsisimula ang event?"
    );

    return true;
  }

  // TIME
  if (session.stage === "time") {
    session.eventTime = message;
    session.stage = "duration";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Ilang oras po ang kabuuang photography coverage na kailangan ninyo?"
    );

    return true;
  }

  // DURATION
  if (session.stage === "duration") {
    const hours = Number.parseFloat(message);

    if (!Number.isFinite(hours) || hours <= 0) {
      await replyAndSave(
        senderId,
        "Pakilagay po ang valid na bilang ng oras, halimbawa: 3."
      );
      return true;
    }

    session.duration = hours;
    session.stage = "venue";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Saan po gaganapin ang event? Pakibigay ang venue at location."
    );

    return true;
  }

  // VENUE
  if (session.stage === "venue") {
    session.venue = message;
    session.stage = "contact";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Ano po ang inyong contact number na maaaring tawagan o i-message ng aming team?"
    );

    return true;
  }

  // CONTACT
  if (session.stage === "contact") {
    session.contact = message;
    session.stage = "delivery";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Para sa processed digital photos, ano po ang inyong preferred delivery method?\n\n1 - Google Drive\n2 - Pitik ng Apo Facebook Page\n3 - Hindi pa sigurado / pag-usapan muna"
    );

    return true;
  }

  // DELIVERY
  if (session.stage === "delivery") {
    if (message === "1" || lower.includes("drive")) {
      session.delivery = "Google Drive";
    } else if (message === "2" || lower.includes("facebook")) {
      session.delivery = "Pitik ng Apo Facebook Page";
    } else if (
      message === "3" ||
      lower.includes("sigurado") ||
      lower.includes("discuss")
    ) {
      session.delivery = "To be discussed";
    } else {
      await replyAndSave(
        senderId,
        "Pili lamang po:\n1 - Google Drive\n2 - Facebook Page\n3 - Hindi pa sigurado"
      );
      return true;
    }

    session.stage = "confirm";
    await saveBookingSession(senderId, session);

    const selectedPackage = PACKAGES[session.package];

    const summary = `
📸 PITIK NG APO - BOOKING INQUIRY SUMMARY

Name: ${session.name}
Package: ${selectedPackage.name}
Event: ${session.eventType}
Date: ${session.eventDate}
Start time: ${session.eventTime}
Coverage: ${session.duration} hours
Venue: ${session.venue}
Contact: ${session.contact}

Digital photo delivery: ${session.delivery}

Base package price: ₱${selectedPackage.price.toLocaleString("en-PH")}

IMPORTANT:
Final quotation and schedule are subject to team confirmation.
Walang automatic additional-hour computation.
Digital photos require 2–3 days processing after the event.
Photo Printing Service is coming soon.

Please review your details.

Reply YES to confirm your inquiry.
Reply NO to cancel.
`;

    await replyAndSave(senderId, summary);
    return true;
  }

  // CONFIRMATION
  if (session.stage === "confirm") {
    if (
      ["yes", "oo", "confirm", "confirmed", "tama"].includes(lower)
    ) {
      const selectedPackage = PACKAGES[session.package];

      const bookingData = {
        senderId,
        customerName: session.name,
        contactNumber: session.contact,
        packageNumber: session.package,
        packageName: selectedPackage.name,
        eventType: session.eventType,
        eventDate: session.eventDate,
        eventTime: session.eventTime,
        durationHours: session.duration,
        venue: session.venue,
        digitalPhotoDelivery: session.delivery,
        basePrice: selectedPackage.price,
        priceStatus: "Subject to team confirmation",
        bookingStatus: "Pending team review",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const bookingRef = await db
        .collection("bookings")
        .add(bookingData);

      await clearBookingSession(senderId);

      await replyAndSave(
        senderId,
        `Maraming salamat po! Na-save na ang inyong booking inquiry.\n\nReference ID: ${bookingRef.id}\n\nAng inyong inquiry ay naghihintay pa ng review at confirmation ng Pitik ng Apo team. Hindi pa po ito confirmed booking.\n\nMaghihintay po kayo ng follow-up mula sa aming team. 😊`
      );

      console.log("[BOOKING] Inquiry saved:", bookingRef.id);
      return true;
    }

    if (["no", "hindi", "cancel"].includes(lower)) {
      await clearBookingSession(senderId);

      await replyAndSave(
        senderId,
        "Sige po. Hindi natin itinuloy ang inquiry. Maaari po kayong mag-message ulit kung nais ninyong magsimula ng bagong booking inquiry."
      );

      return true;
    }

    await replyAndSave(
      senderId,
      "Pakireply po ng YES kung tama ang booking details at nais ninyong i-save ang inquiry, o NO kung nais ninyong kanselahin."
    );

    return true;
  }

  return true;
}

// ==========================================
// 12. PROCESS CUSTOMER MESSAGE
// ==========================================

async function processMessage(senderId, userMessage) {
  const shortSender = String(senderId).slice(-4);

  console.log("[PROCESS] Started:", {
    sender: shortSender,
    messageLength: userMessage.length,
    time: new Date().toISOString()
  });

  await saveConversationMessage(
    senderId,
    "user",
    userMessage
  );

  const activeSession = await getBookingSession(senderId);

  if (activeSession && activeSession.active) {
    console.log("[PROCESS] Active booking session:", shortSender);

    await handleBooking(senderId, userMessage);
    return;
  }

  const lower = userMessage.toLowerCase();

  const bookingKeywords = [
    "booking",
    "book",
    "magbook",
    "mag-book",
    "package",
    "packages",
    "rates",
    "presyo",
    "magkano",
    "quotation",
    "inquire",
    "inquiry",
    "available ba",
    "availability"
  ];

  const isBookingIntent = bookingKeywords.some(keyword =>
    lower.includes(keyword)
  );

  if (isBookingIntent) {
    console.log("[PROCESS] Booking intent detected:", shortSender);
    await startBooking(senderId);
    return;
  }

  console.log("[PROCESS] Sending message to Gemini:", shortSender);

  const history = await getConversationHistory(senderId);
  const aiReply = await generateGeminiReply(history);

  await replyAndSave(senderId, aiReply);

  console.log("[PROCESS] Completed:", shortSender);
}

// ==========================================
// 13. PER-SENDER MESSAGE QUEUE
// ==========================================

const senderQueues = new Map();
const processedMessageIds = new Set();

function queueMessage(senderId, message, messageId) {
  if (messageId) {
    if (processedMessageIds.has(messageId)) {
      console.log("[QUEUE] Duplicate message ignored");
      return;
    }

    processedMessageIds.add(messageId);

    if (processedMessageIds.size > 5000) {
      const oldest = processedMessageIds.values().next().value;
      processedMessageIds.delete(oldest);
    }
  }

  const previous = senderQueues.get(senderId) || Promise.resolve();

  const current = previous
    .catch(error => {
      console.error("[QUEUE] Previous task error:", error.message);
    })
    .then(() => processMessage(senderId, message))
    .catch(error => {
      console.error("[PROCESS] FAILED:", {
        sender: String(senderId).slice(-4),
        error: error.stack || error.message
      });
    });

  senderQueues.set(senderId, current);

  current.finally(() => {
    if (senderQueues.get(senderId) === current) {
      senderQueues.delete(senderId);
    }
  });
}

// ==========================================
// 14. HTTP SERVER
// ==========================================

const server = http.createServer((req, res) => {
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  console.log("[HTTP]", req.method, requestUrl.pathname);

  // HEALTH CHECK
  if (
    req.method === "GET" &&
    requestUrl.pathname === "/"
  ) {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    return res.end("Pitik ng Apo Bot is running.");
  }

  // META WEBHOOK VERIFICATION
  if (
    req.method === "GET" &&
    requestUrl.pathname === "/webhook"
  ) {
    const mode = requestUrl.searchParams.get("hub.mode");
    const token = requestUrl.searchParams.get("hub.verify_token");
    const challenge = requestUrl.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("[WEBHOOK] Verification successful");
      res.writeHead(200);
      return res.end(challenge);
    }

    console.error("[WEBHOOK] Verification failed");
    res.writeHead(403);
    return res.end("Verification failed");
  }

  // MESSENGER WEBHOOK
  if (
    req.method === "POST" &&
    requestUrl.pathname === "/webhook"
  ) {
    console.log("[WEBHOOK] POST RECEIVED");

    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", () => {
      let data;

      try {
        data = JSON.parse(body);
      } catch (error) {
        console.error("[WEBHOOK] Invalid JSON:", error.message);
        res.writeHead(400);
        return res.end("Invalid JSON");
      }

      // Acknowledge Meta immediately
      res.writeHead(200);
      res.end("EVENT_RECEIVED");

      console.log("[WEBHOOK] Object:", data.object);

      if (data.object !== "page") {
        console.log("[WEBHOOK] Ignored non-page event");
        return;
      }

      for (const entry of data.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;

          const shortSender = senderId
            ? String(senderId).slice(-4)
            : "UNKNOWN";

          console.log("[WEBHOOK] Event:", {
            sender: shortSender,
            hasMessage: !!event.message,
            hasText: typeof event.message?.text === "string",
            isEcho: event.message?.is_echo === true,
            hasPostback: !!event.postback,
            hasDelivery: !!event.delivery,
            hasRead: !!event.read
          });

          if (
            event.message &&
            typeof event.message.text === "string" &&
            event.message.is_echo !== true &&
            senderId
          ) {
            console.log("[WEBHOOK] CUSTOMER TEXT DETECTED");

            queueMessage(
              senderId,
              event.message.text,
              event.message.mid
            );

          } else {
            console.log("[WEBHOOK] Event ignored");
          }
        }
      }
    });

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ==========================================
// 15. START SERVER
// ==========================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] Pitik ng Apo Bot running on port ${PORT}`);
});
