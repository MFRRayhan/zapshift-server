/* ==============================
CORE IMPORTS
============================== */
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

/* ==============================
APP INIT
============================== */
const app = express();
const port = process.env.PORT || 4000;

/* ==============================
GLOBAL MIDDLEWARE
============================== */
// API-only backend: allow all origins.
// If you need to restrict origins, set them explicitly.
app.use(cors());
app.use(express.json());

// Respond to OPTIONS preflight requests for all routes
app.options("*", cors());

/* ==============================
ROOT HEALTH CHECK
Defined synchronously — always available even if DB fails.
============================== */
app.get("/", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "ZapShift API is running 🚀",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    endpoints: ["/users", "/parcels", "/riders", "/payments", "/parcel-track/:id"],
  });
});

// Secondary health-check: attempts a live DB ping
app.get("/health", async (req, res) => {
  const dbStatus = { connected: false, error: null };
  try {
    await connectToDatabase();
    dbStatus.connected = true;
  } catch (e) {
    dbStatus.error = e.message;
  }
  const code = dbStatus.connected ? 200 : 503;
  res.status(code).json({
    status: dbStatus.connected ? "ok" : "degraded",
    uptime: process.uptime(),
    database: dbStatus,
    env: {
      DB_URI_set: !!process.env.DB_URI,
      FB_SERVICE_KEY_set: !!process.env.FB_SERVICE_KEY,
      STRIPE_SECRET_KEY_set: !!process.env.STRIPE_SECRET_KEY,
      SITE_DOMAIN: process.env.SITE_DOMAIN || "(not set)",
      NODE_ENV: process.env.NODE_ENV || "(not set)",
    },
  });
});

// Debug endpoint: shows the exact error preventing DB connection
app.get("/debug", async (req, res) => {
  const info = {
    DB_URI_set: !!process.env.DB_URI,
    // Show a masked version so you can confirm the URI is loaded without exposing credentials
    DB_URI_prefix: process.env.DB_URI
      ? process.env.DB_URI.substring(0, 30) + "..."
      : "NOT SET",
    FB_SERVICE_KEY_set: !!process.env.FB_SERVICE_KEY,
    STRIPE_SECRET_KEY_set: !!process.env.STRIPE_SECRET_KEY,
    NODE_ENV: process.env.NODE_ENV || "(not set)",
  };

  try {
    await connectToDatabase();
    return res.status(200).json({ status: "ok", message: "DB connected", env: info });
  } catch (err) {
    return res.status(503).json({
      status: "error",
      message: err.message,
      errorName: err.name,
      errorCode: err.code,
      codeName: err.codeName,
      env: info,
      fix: [
        "1. MongoDB Atlas → Network Access → Add IP 0.0.0.0/0",
        "2. Vercel Dashboard → Settings → Environment Variables → confirm DB_URI is set",
        "3. Use mongodb+srv:// format in DB_URI (not the old direct shard address)",
        "4. Atlas free-tier: check your cluster is not paused",
      ],
    });
  }
});

/* ==============================
STRIPE INIT (lazy — avoids crash if key is missing)
============================== */
let stripe;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  } else {
    console.warn("⚠️  STRIPE_SECRET_KEY is not set. Payment routes will fail.");
  }
} catch (err) {
  console.error("❌ Stripe initialization failed:", err.message);
}

/* ==============================
FIREBASE ADMIN INIT (lazy — avoids crash if env var is missing)
============================== */
const admin = require("firebase-admin");

let firebaseInitialized = false;
try {
  if (process.env.FB_SERVICE_KEY) {
    const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
      "utf8",
    );
    const serviceAccount = JSON.parse(decoded);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    firebaseInitialized = true;
  } else {
    console.warn(
      "⚠️  FB_SERVICE_KEY is not set. Auth middleware will be unavailable.",
    );
  }
} catch (err) {
  console.error("❌ Firebase Admin initialization failed:", err.message);
}

/* ==============================
CUSTOM MIDDLEWARE
============================== */
const verifyFBToken = async (req, res, next) => {
  if (!firebaseInitialized) {
    console.error("Firebase is not initialized. Cannot verify token.");
    return res.status(500).send({ message: "Auth service unavailable" });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  const idToken = authHeader.split(" ")[1];
  if (!idToken) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Firebase token error:", error.message);
    res.status(401).send({ message: "unauthorized access" });
  }
};

/* ==================================
CUSTOM FUNCTION
================================== */
const generateTrackingId = () => {
  const prefix = "ZAP";
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
};

/* ==============================
DATABASE CONFIG (connection caching for serverless)
============================== */

// Support both SRV and legacy URI formats.
// In Vercel dashboard, set DB_URI to your mongodb+srv:// connection string.
const uri = process.env.DB_URI;

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
  // Reuse existing connection across warm serverless invocations
  if (cachedClient && cachedDb) {
    try {
      // Ping to confirm the cached connection is still alive
      await cachedClient.db("admin").command({ ping: 1 });
      return { client: cachedClient, db: cachedDb };
    } catch (_) {
      // Connection dropped — clear cache and reconnect below
      cachedClient = null;
      cachedDb = null;
    }
  }

  if (!uri) {
    throw new Error(
      "DB_URI environment variable is not set. Add it in Vercel Project Settings → Environment Variables.",
    );
  }

  console.log("⏳ Connecting to MongoDB...");

  const client = new MongoClient(uri, {
    // serverApi strict mode disabled — strict:true rejects find/sort/skip used throughout
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: false,
    },
    // Serverless-optimised pool settings
    maxPoolSize: 10,
    minPoolSize: 0,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 60000,
    // NOTE: Do NOT set tls:true here if your URI already contains ssl=true or mongodb+srv://
    // Setting both causes TLS negotiation conflicts on Atlas
  });

  try {
    await client.connect();
    // Verify the connection works before caching it
    await client.db("admin").command({ ping: 1 });
  } catch (err) {
    // Log the full error details to Vercel function logs
    console.error("❌ MongoDB connection failed:");
    console.error("   Error name   :", err.name);
    console.error("   Error message:", err.message);
    console.error("   Error code   :", err.code);
    console.error("   Codename     :", err.codeName);
    // Re-throw so the run() catch block handles it
    throw err;
  }

  cachedClient = client;
  cachedDb = client.db("zapShitDB");

  console.log("✅ MongoDB connected and verified");
  return { client: cachedClient, db: cachedDb };
}

/* ==============================
ROUTES + DB CONNECTION
============================== */
async function run() {
  try {
    const { db } = await connectToDatabase();

    /* ==============================
    COLLECTIONS
    ============================== */
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");
    const trackingsCollection = db.collection("trackings");

    /* ==================================
    VERIFY ADMIN MIDDLEWARE
    ================================== */
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.user.email;
        const query = { userEmail: email };
        const userResult = await usersCollection.findOne(query);

        if (!userResult || userResult?.role !== "admin") {
          return res.status(403).send({ message: "forbidden access" });
        }

        next();
      } catch (error) {
        console.error("verifyAdmin error:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    };

    /* ==================================
    LOG TRACKING
    ================================== */
    const logTracking = async (trackingId, status) => {
      try {
        const log = {
          trackingId,
          status,
          details: status.split("_").join(" "),
          createdAt: new Date(),
        };
        return await trackingsCollection.insertOne(log);
      } catch (err) {
        console.error("logTracking error:", err.message);
      }
    };

    /* ==================================
    USERS
    ================================== */
    app.get("/users", async (req, res) => {
      try {
        const { email, search, skip = 0, limit = 0 } = req.query;
        const emailQuery = { userEmail: email };

        if (email) {
          const user = await usersCollection.findOne(emailQuery);
          return res.send(user);
        }

        const searchQuery = {};

        if (search) {
          searchQuery.$or = [
            { displayName: { $regex: search, $options: "i" } },
            { userEmail: { $regex: search, $options: "i" } },
          ];
        }

        const result = await usersCollection
          .find(searchQuery)
          .skip(Number(skip))
          .limit(Number(limit))
          .toArray();

        const totalUsers = await usersCollection.countDocuments(searchQuery);

        res.send({ users: result, totalUsers });
      } catch (error) {
        console.error("Error fetching users:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.get("/users/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await usersCollection.findOne(query);
        res.send(result);
      } catch (error) {
        console.error("Error fetching user by id:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;
        const query = { userEmail: email };
        const user = await usersCollection.findOne(query);
        res.send(user?.role || "user");
      } catch (error) {
        console.error("Error fetching user role:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.patch("/users/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const role = req.body.role;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const update = { $set: { role } };
        const result = await usersCollection.updateOne(query, update);
        res.send(result);
      } catch (error) {
        console.error("Error updating user role:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.patch("/users/profile/:id", verifyFBToken, async (req, res) => {
      try {
        const { displayName, photoURL } = req.body;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const updateDoc = { $set: { displayName, photoURL } };
        const result = await usersCollection.updateOne(query, updateDoc);
        res.send(result);
      } catch (error) {
        console.error("Error updating user profile:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.post("/users", async (req, res) => {
      try {
        const newUser = req.body;
        const { userEmail } = req.body;
        const query = { userEmail };
        const existingUser = await usersCollection.findOne(query);

        if (existingUser) return res.send({ message: "User already exist" });

        const result = await usersCollection.insertOne(newUser);
        res.send(result);
      } catch (error) {
        console.error("Error creating user:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.delete("/users/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await usersCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error("Error deleting user:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    /* -------------------------------------------------------------------------- */

    /* ==================================
    Parcels API
    ================================== */

    // FOR USERS
    app.get("/parcels", async (req, res) => {
      try {
        const {
          email,
          search,
          limit = 0,
          skip = 0,
          deliveryStatus,
          trackingId,
        } = req.query;

        const query = {};

        if (email) query.senderEmail = email;

        if (search) {
          query.$or = [
            { parcelName: { $regex: search, $options: "i" } },
            { senderName: { $regex: search, $options: "i" } },
            { receiverName: { $regex: search, $options: "i" } },
            { senderEmail: { $regex: search, $options: "i" } },
            { receiverEmail: { $regex: search, $options: "i" } },
          ];
        }

        if (deliveryStatus) query.deliveryStatus = deliveryStatus;
        if (trackingId) query.trackingId = trackingId;

        const cursor = parcelsCollection
          .find(query)
          .limit(Number(limit))
          .skip(Number(skip))
          .sort({ createdAt: -1 });
        const result = await cursor.toArray();

        const totalParcels = await parcelsCollection.countDocuments(query);
        res.send({ parcels: result, totalParcels });
      } catch (error) {
        console.error("Error fetching parcels:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    // FOR ADMIN
    app.get("/admin/parcels", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { limit = 0, skip = 0, deliveryStatus, search } = req.query;
        const query = {};

        if (search) {
          query.$or = [
            { parcelName: { $regex: search, $options: "i" } },
            { senderName: { $regex: search, $options: "i" } },
            { receiverName: { $regex: search, $options: "i" } },
            { senderEmail: { $regex: search, $options: "i" } },
            { receiverEmail: { $regex: search, $options: "i" } },
          ];
        }

        if (deliveryStatus) query.deliveryStatus = deliveryStatus;

        const result = await parcelsCollection
          .find(query)
          .limit(Number(limit))
          .skip(Number(skip))
          .sort({ createdAt: -1 })
          .toArray();

        const totalParcels = await parcelsCollection.countDocuments(query);

        res.send({ parcels: result, totalParcels });
      } catch (error) {
        console.error("Error fetching admin parcels:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.get("/parcels/rider", async (req, res) => {
      try {
        const {
          riderEmail,
          deliveryStatus,
          limit = 20,
          skip = 0,
          search = "",
        } = req.query;

        const query = {};

        if (riderEmail) query.riderEmail = riderEmail;

        if (deliveryStatus) {
          query.deliveryStatus = {
            $in: [
              "driver_assigned",
              "rider_accepted",
              "picked_up",
              "in_transit",
              "delivered",
            ],
          };
        }

        if (search) {
          query.$or = [
            { parcelName: { $regex: search, $options: "i" } },
            { receiverName: { $regex: search, $options: "i" } },
            { senderDistrict: { $regex: search, $options: "i" } },
            { receiverDistrict: { $regex: search, $options: "i" } },
          ];
        }

        const result = await parcelsCollection
          .find(query)
          .skip(parseInt(skip))
          .limit(parseInt(limit))
          .toArray();

        const totalAssignedDeliveries =
          await parcelsCollection.countDocuments(query);

        res.send({ parcels: result, totalAssignedDeliveries });
      } catch (error) {
        console.error("Error fetching rider parcels:", error.message);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/parcels/rider/completed-deliveries", async (req, res) => {
      try {
        const {
          riderEmail,
          deliveryStatus,
          limit = 20,
          skip = 0,
          search = "",
        } = req.query;

        const query = {};

        if (riderEmail) query.riderEmail = riderEmail;

        if (deliveryStatus) {
          query.deliveryStatus = { $in: ["delivered"] };
        }

        if (search) {
          query.$or = [
            { parcelName: { $regex: search, $options: "i" } },
            { receiverName: { $regex: search, $options: "i" } },
            { senderDistrict: { $regex: search, $options: "i" } },
            { receiverDistrict: { $regex: search, $options: "i" } },
          ];
        }

        const result = await parcelsCollection
          .find(query)
          .skip(parseInt(skip))
          .limit(parseInt(limit))
          .toArray();

        const totalCompletedDeliveries =
          await parcelsCollection.countDocuments(query);

        res.send({ parcels: result, totalCompletedDeliveries });
      } catch (error) {
        console.error("Error fetching completed deliveries:", error.message);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelsCollection.findOne(query);
        res.send(result);
      } catch (error) {
        console.error("Error fetching parcel by id:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const trackingId = generateTrackingId();

        newParcel.trackingId = trackingId;
        newParcel.deliveryStatus = "parcel_created";

        const result = await parcelsCollection.insertOne(newParcel);

        await trackingsCollection.insertOne({
          trackingId,
          status: "parcel_created",
          details: "Parcel created",
          createdAt: new Date(),
        });

        res.send({ success: true, trackingId, result });
      } catch (error) {
        console.error("Error creating parcel:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      try {
        const { deliveryStatus, riderId, trackingId } = req.body;
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const update = { $set: { deliveryStatus } };

        if (deliveryStatus === "pending_pickup" && riderId) {
          await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            { $set: { workStatus: "available" } },
          );
        }

        if (deliveryStatus === "delivered" && riderId) {
          await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            { $set: { workStatus: "available" } },
          );
        }

        await logTracking(trackingId, deliveryStatus);

        const result = await parcelsCollection.updateOne(filter, update);
        res.send(result);
      } catch (error) {
        console.error("Error updating parcel status:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    // UPDATE PARCEL INFO
    app.patch("/parcels/:id", async (req, res) => {
      try {
        const {
          receiverName,
          receiverEmail,
          receiverPhone,
          receiverAddress,
          receiverDistrict,
          deliveryInstructions,
        } = req.body;
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const update = {
          $set: {
            receiverName,
            receiverEmail,
            receiverPhone,
            receiverAddress,
            receiverDistrict,
            deliveryInstructions,
          },
        };

        const result = await parcelsCollection.updateOne(filter, update);
        res.send(result);
      } catch (error) {
        console.error("Error updating parcel:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    // UPDATE PARCEL INFO WITH RIDER INFO:
    app.patch("/parcels/assign-rider/:id", async (req, res) => {
      try {
        const { riderId, riderName, riderEmail, phoneNumber, trackingId } =
          req.body;
        const id = req.params.id;

        const filter = { _id: new ObjectId(id) };
        const update = {
          $set: {
            riderId,
            riderName,
            riderEmail,
            phoneNumber,
            deliveryStatus: "driver_assigned",
          },
        };

        const parcelResult = await parcelsCollection.updateOne(filter, update);

        const riderQuery = { _id: new ObjectId(riderId) };
        const updateRider = { $set: { workStatus: "in_delivery" } };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          updateRider,
        );

        await logTracking(trackingId, "driver_assigned");

        return res.send({ parcelResult, riderResult });
      } catch (error) {
        console.error("Error assigning rider:", error.message);
        return res
          .status(500)
          .send({ message: "Server error", error: error.message });
      }
    });

    // RIDER REQUEST FOR PAYOUT
    app.patch("/parcels/:id/request-payout", async (req, res) => {
      try {
        const { payoutAmount } = req.body;
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const update = {
          $set: {
            payoutAmount,
            payoutStatus: "paid",
            payoutRequestedAt: new Date(),
          },
        };
        const result = await parcelsCollection.updateOne(filter, update);
        res.send(result);
      } catch (error) {
        console.error("Error requesting payout:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.get("/rider-payments", async (req, res) => {
      try {
        const { riderEmail, search = "", skip = 0, limit = 20 } = req.query;

        const query = {
          riderEmail,
          payoutStatus: { $exists: true },
        };

        if (search) {
          query.$or = [
            { parcelName: { $regex: search, $options: "i" } },
            { trackingId: { $regex: search, $options: "i" } },
            { receiverName: { $regex: search, $options: "i" } },
          ];
        }

        const skipNumber = parseInt(skip);
        const limitNumber = parseInt(limit);

        const parcels = await parcelsCollection
          .find(query)
          .sort({ payoutRequestedAt: -1 })
          .skip(skipNumber)
          .limit(limitNumber)
          .toArray();

        const totalPayments = await parcelsCollection.countDocuments(query);

        res.send({ parcels, totalPayments });
      } catch (error) {
        console.error("Error fetching rider payments:", error.message);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await parcelsCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    /* -------------------------------------------------------------------------- */

    /* ==================================
    Stripe Payment Api
    ================================== */

    app.post("/create-checkout-session", async (req, res) => {
      try {
        if (!stripe) {
          return res
            .status(500)
            .send({ message: "Payment service not configured" });
        }

        const parcelInfo = req.body;
        const amount = parseInt(parcelInfo.cost) * 100;
        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "BDT",
                unit_amount: amount,
                product_data: {
                  name: parcelInfo.parcelName,
                },
              },
              quantity: 1,
            },
          ],
          metadata: {
            parcelId: parcelInfo.parcelId,
            parcelName: parcelInfo.parcelName,
            trackingId: parcelInfo.trackingId,
            senderName: parcelInfo.senderName,
          },
          customer_email: parcelInfo.senderEmail,
          mode: "payment",
          success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe checkout error:", error.message);
        res.status(500).send({ message: "Payment session creation failed" });
      }
    });

    app.patch("/payment-success", async (req, res) => {
      try {
        if (!stripe) {
          return res
            .status(500)
            .send({ message: "Payment service not configured" });
        }

        const sessionId = req.query.session_id;
        if (!sessionId) {
          return res.send({
            success: false,
            message: "session_id is required",
          });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (!session || session.payment_status !== "paid") {
          return res.send({
            success: false,
            message: "invalid session / payment not complete yet",
          });
        }

        const transactionId = session.payment_intent;

        const paymentExist = await paymentsCollection.findOne({ transactionId });

        if (paymentExist) {
          return res.send({
            success: true,
            message: "Payment already processed",
            payment: paymentExist,
          });
        }

        const parcelId = session.metadata?.parcelId;
        if (!parcelId) {
          return res.send({ success: false, message: "parcelId is missing" });
        }

        const parcelName = session.metadata?.parcelName;
        const trackingId = session.metadata?.trackingId;

        const payment = {
          trackingId,
          transactionId,
          parcelId,
          parcelName,
          amount: session.amount_total / 100,
          currency: session.currency,
          senderEmail: session.customer_email,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(payment);

        const query = { _id: new ObjectId(parcelId) };
        const update = {
          $set: {
            trackingId,
            paymentStatus: "paid",
            deliveryStatus: "pending_pickup",
            paidAt: new Date(),
          },
        };
        const parcelResult = await parcelsCollection.updateOne(query, update);

        await logTracking(trackingId, "pending_pickup");

        return res.send({
          success: true,
          message: "Payment successful",
          payment,
          parcelResult,
          paymentResult,
        });
      } catch (error) {
        console.error("Payment-success error:", error.message);
        return res.status(500).send({ message: "Internal Server Error" });
      }
    });

    /* -------------------------------------------------------------------------- */

    /* ==================================
    PAYMENT API's
    ================================== */

    // FOR USERS
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const query = {};
        const { email, search, skip = 0, limit = 0 } = req.query;

        if (email) {
          query.senderEmail = email;
          if (email !== req.user.email) {
            return res.status(403).send({ message: "forbidden access" });
          }
        }

        if (search) {
          query.$or = [
            { parcelName: { $regex: search, $options: "i" } },
            { senderName: { $regex: search, $options: "i" } },
            { receiverName: { $regex: search, $options: "i" } },
            { senderEmail: { $regex: search, $options: "i" } },
            { receiverEmail: { $regex: search, $options: "i" } },
          ];
        }

        const result = await paymentsCollection
          .find(query)
          .limit(Number(limit))
          .skip(Number(skip))
          .sort({ paidAt: -1 })
          .toArray();
        const totalPayments = await paymentsCollection.countDocuments(query);

        res.send({ payments: result, totalPayments });
      } catch (error) {
        console.error("Error fetching payments:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    // FOR ADMIN
    app.get(
      "/admin/payments",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { skip = 0, limit = 0, search = "" } = req.query;
          const query = {};

          if (search) {
            query.$or = [
              { parcelName: { $regex: search, $options: "i" } },
              { senderName: { $regex: search, $options: "i" } },
              { receiverName: { $regex: search, $options: "i" } },
              { senderEmail: { $regex: search, $options: "i" } },
              { receiverEmail: { $regex: search, $options: "i" } },
            ];
          }

          const result = await paymentsCollection
            .find(query)
            .limit(Number(limit))
            .skip(Number(skip))
            .sort({ paidAt: -1 })
            .toArray();
          const totalPayments = await paymentsCollection.countDocuments(query);

          res.send({ payments: result, totalPayments });
        } catch (error) {
          console.error("Error fetching admin payments:", error.message);
          res.status(500).send({ message: "internal server error" });
        }
      },
    );

    /* -------------------------------------------------------------------------- */

    /* ==================================
    RIDER API's
    ================================== */
    app.get("/riders", async (req, res) => {
      try {
        const {
          status,
          search,
          skip = 0,
          limit = 0,
          workStatus,
          district,
        } = req.query;
        const query = {};

        if (status) query.status = status;
        if (workStatus) query.workStatus = workStatus;
        if (district) query.district = district;

        if (search) {
          query.$or = [
            { riderName: { $regex: search, $options: "i" } },
            { riderEmail: { $regex: search, $options: "i" } },
          ];
        }

        const result = await ridersCollection
          .find(query)
          .skip(Number(skip))
          .limit(Number(limit))
          .sort({ createdAt: -1 })
          .toArray();
        const totalRiders = await ridersCollection.countDocuments(query);

        res.send({ riders: result, totalRiders });
      } catch (error) {
        console.error("Error fetching riders:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.patch(
      "/riders/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const status = req.body.status;
          const id = req.params.id;
          const query = { _id: new ObjectId(id) };
          let update = { $set: { status } };

          if (status === "approved") {
            update.$set.workStatus = "available";
          }

          if (status === "rejected") {
            update.$set.workStatus = "rejected";
          }

          const result = await ridersCollection.updateOne(query, update);

          if (status === "approved" || status === "rejected") {
            const email = req.body.email;
            const userQuery = { userEmail: email };
            const userUpdate = {
              $set: { role: status === "approved" ? "rider" : "user" },
            };
            await usersCollection.updateOne(userQuery, userUpdate);
          }

          res.send(result);
        } catch (error) {
          console.error("Error updating rider status:", error.message);
          res.status(500).send({ message: "internal server error" });
        }
      },
    );

    app.post("/riders", async (req, res) => {
      try {
        const newRider = req.body;
        newRider.status = "pending";
        newRider.createdAt = new Date().toISOString();
        const result = await ridersCollection.insertOne(newRider);
        res.send(result);
      } catch (error) {
        console.error("Error creating rider:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.delete("/riders/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await ridersCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error("Error deleting rider:", error.message);
        res.status(500).send({ message: "internal server error" });
      }
    });

    /* ==================================
    PARCEL TRACKING API
    ================================== */
    app.get("/parcel-track/:trackingId", async (req, res) => {
      try {
        const { trackingId } = req.params;

        const parcel = await parcelsCollection.findOne({ trackingId });

        if (!parcel) {
          return res.status(404).send({
            success: false,
            message: "Parcel not found",
          });
        }

        const history = await trackingsCollection
          .find({ trackingId })
          .sort({ createdAt: 1 })
          .toArray();

        res.send({ success: true, parcel, history });
      } catch (error) {
        console.error("Parcel track error:", error.message);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    /* ==============================
    404 HANDLER
    ============================== */
    app.use((req, res) => {
      res.status(404).json({ status: 404, message: "API not found" });
    });

    /* ==============================
    GLOBAL ERROR HANDLER
    ============================== */
    app.use((err, req, res, next) => {
      console.error("Unhandled error:", err.message);
      res.status(500).json({ status: 500, message: "Internal Server Error" });
    });
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:");
    console.error("   Message :", err.message);
    console.error("   Code    :", err.code);
    console.error("   Name    :", err.name);
    console.error(
      "\n📋 Checklist to fix this:\n" +
      "   1. Go to MongoDB Atlas → Network Access → Add IP: 0.0.0.0/0\n" +
      "   2. Confirm DB_URI is set in Vercel → Settings → Environment Variables\n" +
      "   3. Use mongodb+srv:// format (not direct shard addresses)\n" +
      "   4. Confirm cluster is not paused (Atlas free-tier pauses after inactivity)",
    );

    // Register fallback so every request returns a useful JSON error (not blank 500)
    app.use((req, res) => {
      res.status(503).json({
        status: 503,
        message: "Database connection failed. Service temporarily unavailable.",
        // Always expose the real error — needed to diagnose the issue
        error: err.message,
        errorName: err.name,
        fix: [
          "1. MongoDB Atlas → Network Access → Add IP 0.0.0.0/0 (Allow Anywhere)",
          "2. Vercel → Settings → Environment Variables → confirm DB_URI is set",
          "3. Use mongodb+srv:// URI format in Vercel (not direct shard addresses)",
          "4. Check if Atlas free-tier cluster is paused",
        ],
        debug: "/debug endpoint shows full diagnostics",
      });
    });
  }
}

run();

/* ==============================
SERVER START (local development only — Vercel ignores this)
============================== */
// Only call app.listen when NOT in a serverless environment
if (process.env.NODE_ENV !== "production" || process.env.IS_LOCAL === "true") {
  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
}

/* ==============================
EXPORT FOR VERCEL SERVERLESS
============================== */
module.exports = app;
