
const http = require("http");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

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
Ikaw ang customer service assistant ng Pitik ng Apo photography services.

MAHALAGANG PANUNTUNAN:
- Gumamit ng natural, magalang at friendly na Filipino o Taglish.
- Palaging gumamit ng po at opo kung angkop.
- Huwag maging robotic o paulit-ulit.
- Huwag palaging magsimula sa "Salamat po sa inyong pang-unawa."
- Huwag paulit-ulit na magpasalamat sa bawat mensahe.
- Unawain ang natural na Tagalog, Taglish at iba't ibang paraan ng pagtatanong.
- Unawain ang mga numero sa salita gaya ng isa, dalawa, tatlo, apat at iba pa.
- Huwag mag-imbento ng presyo, package, availability o staff details.
- Huwag magsabing confirmed ang booking.
- Ang final quotation at availability ay kailangang kumpirmahin ng team.
- Kapag aktibo ang booking inquiry, huwag baguhin ang booking flow.
- Huwag humingi muli ng impormasyon na naibigay na ng customer.
- Maging concise at malinaw.
`;

const PACKAGES = {
  "1": {
    name: "Birthday / Binyag",
    price: 2500,
    description: "2 hours coverage"
  },
  "2": {
    name: "Community / Corporate Events",
    price: 3500,
    description: "4 hours coverage"
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

Ang package rates ay subject to change depende sa event requirements, oras at lokasyon. Ang final quotation ay manggagaling sa aming team.
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

async function replyAndSave(senderId, message) {
  await saveConversationMessage(senderId, "model", message);
  await sendReply(senderId, message);
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

// FACEBOOK MESSENGER

async function sendMessengerMessage(senderId, messageObject) {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: messageObject
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("Messenger send error:", result);
  }

  return result;
}

async function sendReply(senderId, message) {
  return sendMessengerMessage(senderId, {
    text: message
  });
}

async function sendQuickReplies(senderId, message, options) {
  return sendMessengerMessage(senderId, {
    text: message,
    quick_replies: options.map(option => ({
      content_type: "text",
      title: option.title,
      payload: option.payload
    }))
  });
}

async function replyAndSave(senderId, message) {
  await saveConversationMessage(senderId, "model", message);
  await sendReply(senderId, message);
}

async function quickReplyAndSave(senderId, message, options) {
  await saveConversationMessage(senderId, "model", message);
  await sendQuickReplies(senderId, message, options);
}

// GEMINI

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTemporaryGeminiError(status) {
  return [408, 404, 429, 500, 502, 503, 504].includes(status);
}

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
                maxOutputTokens: 300
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

          return "Pasensya na po, may pansamantalang problema sa aming assistant. Maaari po ba kayong sumubok muli mamaya?";
        }

        const data = await response.json();

        const reply = data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();

        if (reply) {
          console.log("Gemini successful:", model);
          return reply;
        }

        break;

      } catch (error) {
        clearTimeout(timeout);

        console.error(
          `Gemini ${model} attempt ${attempt}:`,
          error.message
        );

        if (attempt < 2) {
          await delay(2000);
        }
      }
    }
  }

  return "Pasensya na po, hindi muna namin makuha ang sagot sa ngayon. Maaari po ba kayong sumubok muli mamaya?";
}

// FORM PARSER

function parseForm(message) {
  const result = {};

  const lines = message.split(/\r?\n/);

  for (const line of lines) {
    const separator = line.indexOf(":");

    if (separator === -1) continue;

    const label = line
      .slice(0, separator)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim();

    const value = line.slice(separator + 1).trim();

    if (!value) continue;

    result[label] = value;
  }

  return result;
}

function findField(data, possibleLabels) {
  for (const label of possibleLabels) {
    if (data[label]) return data[label];
  }

  return "";
}

function getClientFields(message) {
  const data = parseForm(message);

  return {
    name: findField(data, [
      "name",
      "pangalan",
      "full name",
      "buong pangalan"
    ]),
    contact: findField(data, [
      "contact no",
      "contact number",
      "number",
      "mobile number",
      "phone",
      "telepono"
    ]),
    address: findField(data, [
      "address",
      "tirahan",
      "home address"
    ])
  };
}

function getEventFields(message) {
  const data = parseForm(message);

  return {
    eventType: findField(data, [
      "event",
      "event type",
      "uri ng event",
      "klase ng event"
    ]),
    eventDate: findField(data, [
      "date",
      "event date",
      "petsa",
      "araw"
    ]),
    eventTime: findField(data, [
      "time",
      "event time",
      "oras",
      "start time"
    ]),
    venue: findField(data, [
      "location",
      "venue",
      "event location",
      "lugar"
    ])
  };
}

// START INQUIRY

async function startBooking(senderId) {
  const session = {
    active: true,
    stage: "clientInfo",
    startedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await saveBookingSession(senderId, session);

  const message = `Magandang araw po! 📸

Maraming salamat sa pag-message sa Pitik ng Apo.

Ikinalulugod po naming makatulong sa inyong photography needs. Para po maasikaso namin nang maayos ang inyong inquiry, maaari po ba muna naming makuha ang ilang impormasyon tungkol sa inyo?

CLIENT INFORMATION

Name:
Contact Number:
Address:

Pakisagutan lamang po ang mga sumusunod sa isang mensahe. Maraming salamat po!`;

  await replyAndSave(senderId, message);
}

// CLIENT INFORMATION

async function handleClientInfo(senderId, message, session) {
  const fields = getClientFields(message);

  session.name = fields.name || session.name || "";
  session.contact = fields.contact || session.contact || "";
  session.address = fields.address || session.address || "";

  const missing = [];

  if (!session.name) missing.push("Name");
  if (!session.contact) missing.push("Contact Number");
  if (!session.address) missing.push("Address");

  if (missing.length > 0) {
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      `Maraming salamat po. May kulang pa lamang po tayong impormasyon:\n\n${missing.join("\n")}\n\nPakisagot po ang mga kulang na detalye upang maipagpatuloy natin ang inyong inquiry.`
    );

    return;
  }

  session.stage = "eventDetails";
  await saveBookingSession(senderId, session);

  await replyAndSave(
    senderId,
    `Maraming salamat po, ${session.name}! 😊

Ngayon naman po ay nais naming malaman ang ilang detalye tungkol sa inyong event.

EVENT DETAILS

Event:
Date:
Time:
Location / Venue:

Pakisagutan po ang lahat ng detalye sa isang mensahe.`
  );
}

// EVENT DETAILS

async function handleEventDetails(senderId, message, session) {
  const fields = getEventFields(message);

  session.eventType = fields.eventType || session.eventType || "";
  session.eventDate = fields.eventDate || session.eventDate || "";
  session.eventTime = fields.eventTime || session.eventTime || "";
  session.venue = fields.venue || session.venue || "";

  const missing = [];

  if (!session.eventType) missing.push("Event");
  if (!session.eventDate) missing.push("Date");
  if (!session.eventTime) missing.push("Time");
  if (!session.venue) missing.push("Location / Venue");

  if (missing.length > 0) {
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      `Salamat po sa inyong sagot. May kulang pa lamang po tayong detalye:\n\n${missing.join("\n")}\n\nPakibigay po ang mga kulang na impormasyon.`
    );

    return;
  }

  session.stage = "package";
  await saveBookingSession(senderId, session);

  const messageText = `Maraming salamat po sa mga detalye!

Narito naman po ang aming available photography packages. Piliin lamang po ang package na pinakaangkop sa inyong event.

${PACKAGE_MENU}

Alin po sa mga available packages ang nais ninyong piliin?`;

  await quickReplyAndSave(senderId, messageText, [
    {
      title: "Package 1",
      payload: "PACKAGE_1"
    },
    {
      title: "Package 2",
      payload: "PACKAGE_2"
    },
    {
      title: "Sports - Soon",
      payload: "PACKAGE_3"
    }
  ]);
}

// PACKAGE SELECTION

async function handlePackage(senderId, message, payload, session) {
  const lower = message.toLowerCase();

  if (
    payload === "PACKAGE_3" ||
    lower === "3" ||
    lower.includes("sports")
  ) {
    await replyAndSave(
      senderId,
      "Ang Sports Photography po ay COMING SOON pa lamang at hindi pa available for booking. Maaari po kayong pumili sa Package 1 o Package 2."
    );

    return;
  }

  let selected = "";

  if (
    payload === "PACKAGE_1" ||
    lower === "1" ||
    lower.includes("package 1") ||
    lower.includes("birthday")
  ) {
    selected = "1";
  } else if (
    payload === "PACKAGE_2" ||
    lower === "2" ||
    lower.includes("package 2") ||
    lower.includes("community") ||
    lower.includes("corporate")
  ) {
    selected = "2";
  }

  if (!selected) {
    await quickReplyAndSave(
      senderId,
      "Pumili lamang po sa aming available photography packages:",
      [
        { title: "Package 1", payload: "PACKAGE_1" },
        { title: "Package 2", payload: "PACKAGE_2" },
        { title: "Sports - Soon", payload: "PACKAGE_3" }
      ]
    );

    return;
  }

  session.package = selected;
  session.stage = "summary";

  await saveBookingSession(senderId, session);

  const selectedPackage = PACKAGES[selected];

  const summary = `📸 PITIK NG APO
INQUIRY SUMMARY

CLIENT INFORMATION

Name: ${session.name}
Contact Number: ${session.contact}
Address: ${session.address}

EVENT DETAILS

Event: ${session.eventType}
Date: ${session.eventDate}
Time: ${session.eventTime}
Location / Venue: ${session.venue}

SELECTED PACKAGE

${selectedPackage.name}
Package Rate: ₱${selectedPackage.price.toLocaleString("en-PH")}
Coverage: ${selectedPackage.description}

Paalala: Ang package rate ay paunang presyo lamang at maaaring magbago depende sa event requirements at lokasyon. Ang final quotation ay subject to team confirmation.

Pakisuri po ang lahat ng detalye. Tama po ba ang inyong inquiry?`;

  await quickReplyAndSave(senderId, summary, [
    { title: "Tama ang Details", payload: "CONFIRM_DETAILS" },
    { title: "Edit Details", payload: "EDIT_DETAILS" }
  ]);
}

// TERMS AND CONDITIONS

async function sendBookingTerms(senderId, session) {
  session.stage = "terms";
  await saveBookingSession(senderId, session);

  const terms = `📋 BOOKING TERMS AND CONDITIONS

Bago po natin ituloy ang inyong inquiry, narito ang mahahalagang paalala:

1. Ang pagpapadala ng inquiry ay hindi pa nangangahulugang confirmed na ang inyong booking.

2. Ang availability ng schedule ay sasailalim pa sa confirmation ng Pitik ng Apo team.

3. Ang package rates ay maaaring magbago depende sa event requirements, oras, tagal at lokasyon.

4. Ang anumang special request o adjustment sa package ay sasailalim sa evaluation ng team.

5. Ang final quotation ay ibibigay ng aming team matapos masuri ang inyong event details.

6. Makikipag-ugnayan ang aming team upang talakayin ang iba pang detalye at kumpirmahin ang schedule.

Maraming salamat po sa inyong pagtitiwala sa Pitik ng Apo.

Sumasang-ayon po ba kayo sa mga paalala at kondisyon sa itaas?`;

  await quickReplyAndSave(senderId, terms, [
    { title: "Sumasang-ayon", payload: "ACCEPT_TERMS" },
    { title: "Hindi muna", payload: "DECLINE_TERMS" }
  ]);
}

// SAVE CONFIRMED INQUIRY

async function saveConfirmedInquiry(senderId, session) {
  const selectedPackage = PACKAGES[session.package];

  const bookingData = {
    senderId,
    customerName: session.name,
    contactNumber: session.contact,
    address: session.address,
    packageNumber: session.package,
    packageName: selectedPackage.name,
    eventType: session.eventType,
    eventDate: session.eventDate,
    eventTime: session.eventTime,
    venue: session.venue,
    basePrice: selectedPackage.price,
    priceStatus: "Subject to change",
    bookingStatus: "Pending team review",
    termsAccepted: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const bookingRef = await db
    .collection("bookings")
    .add(bookingData);

  session.bookingId = bookingRef.id;
  session.stage = "assistance";

  await saveBookingSession(senderId, session);

  console.log("Inquiry saved:", bookingRef.id);

  await quickReplyAndSave(
    senderId,
    `Maraming salamat po! Naitala na ang inyong inquiry sa aming system.\n\nReference ID: ${bookingRef.id}\n\nMay iba pa po ba kaming maitutulong o may nais pa po ba kayong idagdag sa inyong inquiry?`,
    [
      { title: "Wala na po", payload: "NO_MORE_HELP" },
      { title: "May itatanong po", payload: "MORE_HELP" }
    ]
  );
}

// ADDITIONAL ASSISTANCE

async function handleAssistance(senderId, message, payload, session) {
  const lower = message.toLowerCase();

  if (
    payload === "MORE_HELP" ||
    lower === "yes" ||
    lower.includes("may tanong") ||
    lower.includes("may idadagdag")
  ) {
    session.stage = "additionalNote";
    await saveBookingSession(senderId, session);

    await replyAndSave(
      senderId,
      "Opo, makikinig po kami. Maaari po ninyong ilagay rito ang inyong karagdagang tanong o request at isasama namin ito sa inyong inquiry."
    );

    return;
  }

  await finishInquiry(senderId, session);
}

async function finishInquiry(senderId, session) {
  await clearBookingSession(senderId);

  await replyAndSave(
    senderId,
    `Maraming salamat po sa inyong pagtitiwala sa Pitik ng Apo! 📸

Naitala na ang inyong inquiry at ihahanda ito para sa review ng aming team.

Makakaasa po kayo na makikipag-ugnayan ang aming team para sa final quotation, karagdagang detalye at confirmation ng schedule.

Paalala lamang po na hindi pa confirmed ang inyong booking hangga't hindi ito kinukumpirma ng aming team.

Maraming salamat po at magandang araw! 😊`
  );
}

// BOOKING CONTROLLER

async function handleBooking(senderId, userMessage, payload = "") {
  const message = userMessage.trim();
  const lower = message.toLowerCase();

  let session = await getBookingSession(senderId);

  if (
    ["cancel", "cancel booking", "stop", "hinto", "ayaw na"].includes(lower) ||
    payload === "CANCEL_INQUIRY"
  ) {
    await clearBookingSession(senderId);

    await replyAndSave(
      senderId,
      "Sige po. Hindi natin itinuloy ang kasalukuyang inquiry. Maaari po kayong mag-message muli kung nais ninyong mag-inquire."
    );

    return true;
  }

  if (!session || !session.active) return false;

  if (session.stage === "clientInfo") {
    await handleClientInfo(senderId, message, session);
    return true;
  }

  if (session.stage === "eventDetails") {
    await handleEventDetails(senderId, message, session);
    return true;
  }

  if (session.stage === "package") {
    await handlePackage(senderId, message, payload, session);
    return true;
  }

  if (session.stage === "summary") {
    if (
      payload === "CONFIRM_DETAILS" ||
      ["yes", "oo", "tama", "correct", "confirm"].includes(lower)
    ) {
      await sendBookingTerms(senderId, session);
      return true;
    }

    if (
      payload === "EDIT_DETAILS" ||
      lower.includes("edit") ||
      lower.includes("mali")
    ) {
      session.stage = "clientInfo";
      await saveBookingSession(senderId, session);

      await replyAndSave(
        senderId,
        `Sige po. Maaari po nating ayusin ang inyong impormasyon.\n\nCLIENT INFORMATION\n\nName: ${session.name}\nContact Number: ${session.contact}\nAddress: ${session.address}\n\nPakisend po muli ang tamang impormasyon.`
      );

      return true;
    }

    await quickReplyAndSave(
      senderId,
      "Pakipili po kung tama ang inyong details o nais ninyong mag-edit.",
      [
        { title: "Tama ang Details", payload: "CONFIRM_DETAILS" },
        { title: "Edit Details", payload: "EDIT_DETAILS" }
      ]
    );

    return true;
  }

  if (session.stage === "terms") {
    if (
      payload === "ACCEPT_TERMS" ||
      ["yes", "oo", "agree", "sumasang-ayon", "tanggap"].includes(lower)
    ) {
      await saveConfirmedInquiry(senderId, session);
      return true;
    }

    if (
      payload === "DECLINE_TERMS" ||
      lower === "no" ||
      lower === "hindi"
    ) {
      await clearBookingSession(senderId);

      await replyAndSave(
        senderId,
        "Nauunawaan po namin. Hindi muna natin itutuloy ang inquiry. Maraming salamat po sa pagbisita sa Pitik ng Apo."
      );

      return true;
    }

    await quickReplyAndSave(
      senderId,
      "Sasang-ayon po ba kayo sa aming booking terms?",
      [
        { title: "Sumasang-ayon", payload: "ACCEPT_TERMS" },
        { title: "Hindi muna", payload: "DECLINE_TERMS" }
      ]
    );

    return true;
  }

  if (session.stage === "assistance") {
    await handleAssistance(senderId, message, payload, session);
    return true;
  }

  if (session.stage === "additionalNote") {
    await db.collection("bookings")
      .doc(session.bookingId)
      .update({
        additionalRequest: message,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    await finishInquiry(senderId, session);
    return true;
  }

  return false;
}

// PROCESS MESSENGER MESSAGE

async function processMessage(senderId, userMessage, payload = "") {
  await saveConversationMessage(senderId, "user", userMessage);

  const activeSession = await getBookingSession(senderId);

  if (activeSession && activeSession.active) {
    await handleBooking(senderId, userMessage, payload);
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
    "availability",
    "photographer",
    "photography",
    "magpa-picture",
    "magpa-picture",
    "birthday",
    "binyag",
    "event"
  ];

  const isBookingIntent = bookingKeywords.some(keyword =>
    lower.includes(keyword)
  );

  if (isBookingIntent) {
    await startBooking(senderId);
    return;
  }

  const history = await getConversationHistory(senderId);
  const aiReply = await generateGeminiReply(history);

  await replyAndSave(senderId, aiReply);
}

// HTTP SERVER

const server = http.createServer((req, res) => {

  // META WEBHOOK VERIFICATION

  if (req.method === "GET" && req.url.startsWith("/webhook")) {
    const url = new URL(req.url, `http://${req.headers.host}`);

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

      if (data.object !== "page") return;

      for (const entry of data.entry || []) {
        for (const event of entry.messaging || []) {
          const senderId = event.sender?.id;

          if (!senderId) continue;

          let userMessage = "";
          let payload = "";

          if (event.message && !event.message.is_echo) {
            userMessage = event.message.text || "";
            payload = event.message.quick_reply?.payload || "";
          } else if (event.postback) {
            userMessage = event.postback.title || "Postback response";
            payload = event.postback.payload || "";
          }

          if (!userMessage && !payload) continue;

          processMessage(senderId, userMessage || payload, payload)
            .catch(error => {
              console.error("Message processing error:", error);
            });
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
