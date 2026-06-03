/* ==============================
CORE IMPORTS
============================== */
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

/* ==============================
APP INIT
============================== */
const app = express();
const port = process.env.PORT || 4000;

/* ==============================
GLOBAL MIDDLEWARE
============================== */
app.use(cors());
app.use(express.json());

/* ==============================
FIREBASE CONFIG
============================== */
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

/* ==============================
CUSTOM MIDDLEWARE
============================== */
const verifyFBToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  const idToken = authHeader.split(" ")[1];
  if (!idToken) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (error) {
    console.error("Firebase toker error:", error);
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
DATABASE CONFIG
============================== */
const uri = process.env.DB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

/* ==============================
ROUTES + DB CONNECTION
============================== */
async function run() {
  try {
    await client.connect();

    /* ==============================
    DATABASE
    ============================== */
    const db = client.db("zapShitDB");

    /* ==============================
    COLLECTIONS
    ============================== */
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");

    /* ==================================
    VERIFY ADMIN MIDDLEWARE
    ================================== */
    const verifyAdmin = async (req, res, next) => {
      const email = req.user.email;
      const query = { userEmail: email };
      const userResult = await usersCollection.findOne(query);

      if (!userResult || userResult?.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    /* ==============================
    ROOT
    ============================== */
    app.get("/", (req, res) => {
      res.json({ status: "Ok", message: "Server is running" });
    });

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
        console.error("Error fetching users", error);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.get("/users/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.findOne(query);
      res.send(result);
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { userEmail: email };
      const user = await usersCollection.findOne(query);
      res.send(user?.role || "user");
    });

    app.patch("/users/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const role = req.body.role;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          role,
        },
      };
      const result = await usersCollection.updateOne(query, update);
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      const newUser = req.body;
      const { userEmail } = req.body; // userEmail = mongoDB Key
      const query = { userEmail };
      const existingUser = await usersCollection.findOne(query);

      if (existingUser) return res.send({ message: "User already exist" });

      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    });

    // app.patch("/users/:id", async (req, res) => {});

    app.delete("/users/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    /* ==================================
    Parcels API
    ================================== */
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const {
          email,
          search,
          limit = 0,
          skip = 0,
          deliveryStatus,
        } = req.query;

        const query = {};

        if (email) {
          query.senderEmail = email;
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

        if (deliveryStatus) {
          query.deliveryStatus = deliveryStatus;
        }

        const cursor = parcelsCollection
          .find(query)
          .limit(Number(limit))
          .skip(Number(skip))
          .sort({ createdAt: -1 });
        const result = await cursor.toArray();

        const totalParcels = await parcelsCollection.countDocuments(query);
        res.send({ parcels: result, totalParcels });
      } catch (error) {
        console.error("Error fetching parcels", error);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const newParcel = req.body;
      const result = await parcelsCollection.insertOne(newParcel);
      res.send(result);
    });

    // UPDATE PARCEL INFO
    app.patch("/parcels/:id", async (req, res) => {
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
    });

    // UPDATE PARCEL INFO WITH RIDER INFO:
    app.patch("/parcels/assign-rider/:id", async (req, res) => {
      const { riderId, riderName, riderEmail, phoneNumber } = req.body;
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
      const result = await parcelsCollection.updateOne(filter, update);
      res.send(result);

      const riderQuery = { _id: new ObjectId(riderId) };
      const updateRider = {
        $set: { workStatus: "in_delivery" },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        updateRider,
      );
      res.send(riderResult);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    /* ==================================
    Stripe Payment Api
    ================================== */

    // NEW STRIPE API
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "BDT",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
      });

      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      try {
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

        const paymentExist = await paymentsCollection.findOne({
          transactionId,
        });

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
        const trackingId = generateTrackingId();

        const payment = {
          trackingId,
          transactionId,
          parcelId,
          parcelName,
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
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

        return res.send({
          success: true,
          message: "Payment successful",
          payment,
          parcelResult,
          paymentResult,
        });
      } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).send({ message: "Internal Server Error" });
      }
    });

    /* ==================================
    PAYMENT API's
    ================================== */
    app.get("/payments", verifyFBToken, async (req, res) => {
      const query = {};
      const { email, search, skip = 0, limit = 0 } = req.query;

      if (email) {
        query.customerEmail = email;
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
    });

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
        console.error("Error fetching riders", error);
        res.status(500).send({ message: "internal server error" });
      }
    });

    app.patch("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      let update = {
        $set: {
          status,
        },
      };

      if (status === "approved") {
        update.$set.workStatus = "available";
      }

      if (status === "rejected") {
        update.$set.workStatus = "rejected";
      }

      const result = await ridersCollection.updateOne(query, update);

      if (status === "approved") {
        const email = req.body.email;
        const query = { userEmail: email };
        const update = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await usersCollection.updateOne(query, update);
      }

      if (status === "rejected") {
        const email = req.body.email;
        const query = { userEmail: email };
        const update = {
          $set: {
            role: "user",
          },
        };
        const userResult = await usersCollection.updateOne(query, update);
      }

      res.send(result);
    });

    app.post("/riders", async (req, res) => {
      const newRider = req.body;
      newRider.status = "pending";
      newRider.createdAt = new Date().toISOString();
      const result = await ridersCollection.insertOne(newRider);
      res.send(result);
    });

    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await ridersCollection.deleteOne(query);
      res.send(result);
    });

    /* ==============================
    404 HANDLER
    ============================== */
    app.use((req, res) => {
      res.status(404).json({ status: 404, message: "API not found" });
    });

    console.log("✅ MongoDB connected successfully");
  } catch (err) {
    console.error(err);
  }
}

run();

/* ==============================
SERVER START
============================== */
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
