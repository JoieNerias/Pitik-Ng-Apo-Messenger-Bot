
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

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v24.0";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
Kung may aktibong booking inquiry, sundin ang booking process
ng system at huwag gumawa ng ibang booking details.
`;

// PACKAGE INFORMATION
const PACKAGES = {
  "1": {
    name: "Birthday / Binyag",
    price: 2500,
    includedHours: 2,
    extraRate: 500
  },
  "2": {
    name: "Community / Corporate Events",
    price: 3500,
    includedHours: 4,
    extraRate: 250
  }
};

const PACKAGE_MENU = `
📸 PITIK NG APO PHOTOGRAPHY PACKAGES

PACKAGE 1 – Birthday / Binyag
₱2,500
2 hours coverage
Additional hour: ₱500/hour

PACKAGE 2 – Community / Corporate Events
₱3,500
4 hours coverage
Additional hour: ₱250/hour

PACKAGE 3 – Sports Photography
₱1,000 per game
COMING SOON

PHOTO PRINTING SERVICE
COMING SOON

IMPORTANT:
All prices are subject to change depending on
event time, duration requirements and location.
Final quotation is subject to team confirmation.

Digital photo delivery is optional through
Google Drive or our Facebook Page.
Allow 2–3 days processing after the event.
`;

// FIRESTORE CONVERSATION MEMORY
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

// FIRESTORE BOOKING SESSION
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

// DELAY
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// GEMINI ERROR CHECK
function isTemporaryGeminiError(status) {
  return [408, 404, 429, 500, 502, 503, 504].includes(status);
}

// GEMINI AUTOMATIC MODEL FALLBACK
async function generateGeminiReply(conversationHistory) {

  for (const model of GEMINI_MODELS) {

    console.log("Trying Gemini model:", model);

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

          console.error(
            `Gemini ${model} error (${response.status}):`,
            errorText
          );

          if (isTemporaryGeminiError(response.status)) {
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
          console.log("Gemini response successful using:", model);
          return reply;
        }

        break;

      } catch (error) {
        clearTimeout(timeout);

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

  return "Pasensya na po, hindi muna namin makuha ang sagot sa ngayon. Pakisubukan po ulit mamaya. 😊";
}

// FACEBOOK MESSENGER SEND REPLY
async function sendReply(senderId, message) {

  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text: message }
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("Messenger send error:", result);
  }

  return result;
}

async function replyAndSave(senderId, message) {
  await saveConversationMessage(senderId, "model", message);
  await sendReply(senderId, message);
}

// START BOOKING
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
    "\n\nKung nais ninyong mag-inquire o mag-book, piliin lamang:\n1 - Birthday / Binyag\n2 - Community / Corporate Events\n\nPaalala: Hindi pa available for booking ang Package 3."
  );
}

// BOOKING PROCESS
async function handleBooking(senderId, userMessage) {

  const message = userMessage.trim();
  const lower = message.toLowerCase();

  let session = await getBookingSession(senderId);

  // CANCEL BOOKING
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

  // PACKAGE SELECTION
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
        "Pili lamang po ng available package:\n\n1 - Birthday / Binyag\n2 - Community / Corporate Events"
      );
      return true;
    }

    session.stage = "name";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      `Salamat po! Napili ninyo ang Package ${session.package}: ${PACKAGES[session.package].name}.\n\nAno po ang buong pangalan ninyo?`
    );

    return true;
  }

  // CUSTOMER NAME
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

  // EVENT DATE
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

  // EVENT TIME
  if (session.stage === "time") {
    session.eventTime = message;
    session.stage = "duration";

    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Ilang oras po ang kabuuang photography coverage na kailangan ninyo? Pakilagay po ang bilang ng oras (halimbawa: 3 hours)."
    );

    return true;
  }

  // DURATION
  if (session.stage === "duration") {
    const hours = Number.parseFloat(message);

    if (!Number.isFinite(hours) || hours <= 0) {
      await replyAndSave(
        senderId,
        "Pakilagay po ang valid na bilang ng oras, halimbawa: 3 hours."
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

  // CONTACT NUMBER
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

  // DIGITAL PHOTO DELIVERY
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

    const extraHours = Math.max(
      0,
      session.duration - selectedPackage.includedHours
    );

    const extraCharge =
      extraHours * selectedPackage.extraRate;

    const estimatedPrice =
      selectedPackage.price + extraCharge;

    session.extraHours = extraHours;
    session.estimatedPrice = estimatedPrice;

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
Additional hours: ${extraHours}
Estimated additional charge: ₱${extraCharge.toLocaleString("en-PH")}
Estimated total: ₱${estimatedPrice.toLocaleString("en-PH")}

IMPORTANT:
All prices are subject to change depending on event time, duration and location.
Final quotation and schedule are subject to team confirmation.
Digital photos require 2–3 days processing after the event.
Photo Printing Service is coming soon.

Please review your details.

Reply YES to confirm your inquiry.
Reply NO to cancel.
`;

    await replyAndSave(senderId, summary);

    return true;
  }

  // CUSTOMER CONFIRMATION
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
        additionalHours: session.extraHours ?? 0,
        estimatedPrice: session.estimatedPrice,
        priceStatus: "Subject to change",
        bookingStatus: "Pending team review",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const bookingRef = await db
        .collection("bookings")
        .add(bookingData);

      await clearBookingSession(senderId);

      await replyAndSave(
        senderId,
        `Maraming salamat po! Na-save na ang inyong booking inquiry.\n\nReference ID: ${bookingRef.id}\n\nAng inyong inquiry ay naghihintay pa ng review at confirmation ng Pitik ng Apo team. Hindi pa po ito confirmed booking.\n\nAng final quotation at availability ay depende sa event time, duration at location. Maghihintay po kayo ng follow-up mula sa aming team. 😊`
      );

      console.log("Booking inquiry saved:", bookingRef.id);

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

  return false;
}

// PROCESS MESSENGER MESSAGE
async function processMessage(senderId, userMessage) {

  await sendReply(
    senderId,
    "Salamat po sa inyong message! Sandali lang po habang inihahanda namin ang aming sagot. Salamat sa inyong pang-unawa. 😊"
  );

  await saveConversationMessage(
    senderId,
    "user",
    userMessage
  );

  const activeSession = await getBookingSession(senderId);

  if (activeSession && activeSession.active) {
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
    await startBooking(senderId);
    return;
  }

  // NORMAL AI CONVERSATION
  const history = await getConversationHistory(senderId);

  const aiReply = await generateGeminiReply(history);

  await saveConversationMessage(
    senderId,
    "model",
    aiReply
  );

  await sendReply(senderId, aiReply);
}

// HTTP SERVER
const server = http.createServer((req, res) => {

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

  // MESSENGER WEBHOOK
  if (req.method === "POST" && req.url === "/webhook") {

    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", () => {

      let data;

      try {
        data = JSON.parse(body);
      } catch (error) {
        console.error("Invalid webhook JSON:", error);
        res.writeHead(400);
        return res.end("Invalid JSON");
      }

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

            processMessage(senderId, userMessage)
              .catch(error => {
                console.error("Message processing error:", error);
              });
          }
        }
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
  console.log(`Pitik ng Apo Bot running on port ${PORT}`);
});
