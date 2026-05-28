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
    const userInfo = await admin.auth().verifyIdToken(idToken);
    req.token_email = userInfo.email;
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
      const { email } = req.query;
      const query = { userEmail: email };

      if (email) {
        const user = await usersCollection.findOne(query);
        return res.send(user);
      }

      const result = await usersCollection.find().toArray();
      res.send(result);
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

    app.patch("/users/:id", async (req, res) => {
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
      const query = {};
      const { email } = req.query;

      if (email) query.senderEmail = email;

      const cursor = parcelsCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
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

    // update
    app.patch("/parcels/:id", async (req, res) => {
      const updateData = req.body;
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const update = {
        $set: {
          receiverEmail: updateData.receiverEmail,
          receiverPhone: updateData.receiverPhone,
        },
      };

      const result = await parcelsCollection.updateOne(filter, update);
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
    // OLD API
    // app.post("/create-checkout-session", async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;

    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "BDT",
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //     },
    //     customer_email: paymentInfo.senderEmail,
    //     mode: "payment",
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
    //   });

    //   // console.log(session);
    //   res.send({ url: session.url });
    // });

    // NEW STRIPE API
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      // console.log(paymentInfo);
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
      const sessionId = req.query.session_id;
      if (!sessionId) {
        return res.send({
          success: false,
          message: "session_id is required",
        });
      }

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (!session) {
        return res.send({
          success: false,
          message: "invalid session",
        });
      }

      // PAYMENT CHECK
      if (session.payment_status !== "paid") {
        return res.send({
          success: false,
          message: "payment not complete yet",
        });
      }

      const parcelId = session.metadata?.parcelId;
      if (!parcelId) {
        return res.send({
          success: false,
          message: "parcelId is missing",
        });
      }

      const parcelName = session.metadata?.parcelName;
      const trackingId = generateTrackingId();
      const query = { _id: new ObjectId(parcelId) };
      const update = {
        $set: {
          trackingId,
          paymentStatus: "paid",
          paidAt: new Date(),
        },
      };

      // DUPLICATE PAYMENT CHECK
      const transactionId = session.payment_intent;
      const paymentExist = await paymentsCollection.findOne({ transactionId });

      if (paymentExist) {
        return res.send({
          success: true,
          message: "Payment already exists",
          payment: paymentExist,
        });
      }

      const parcelResult = await parcelsCollection.updateOne(query, update);

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

      return res.send({
        success: true,
        message: "Payment successful",
        payment,
        parcelResult,
        paymentResult,
      });
    });

    // app.patch("/payment-success", async (req, res) => {
    //   const sessionId = req.query.session_id;
    //   const session = await stripe.checkout.sessions.retrieve(sessionId);

    //   const transactionId = session.payment_intent;
    //   const query = { transactionId };
    //   const paymentExist = await paymentsCollection.findOne(query);

    //   if (paymentExist) {
    //     return res.send({
    //       message: "Payment already exist",
    //       transactionId,
    //       trackingId: paymentExist.trackingId,
    //     });
    //   }

    //   if (session.payment_status === "paid") {
    //     const id = session.metadata.parcelId;
    //     const query = { _id: new ObjectId(id) };
    //     const trackingId = generateTrackingId();
    //     const update = {
    //       $set: {
    //         paymentStatus: "paid",
    //         paidAt: new Date().toDateString(),
    //         trackingId,
    //       },
    //     };

    //     const result = await parcelsCollection.updateOne(query, update);

    //     const payment = {
    //       amount: session.amount_total / 100,
    //       currency: session.currency,
    //       customerEmail: session.customer_email,
    //       parcelId: session.metadata.parcelId,
    //       parcelName: session.metadata.parcelName,
    //       transactionId: session.payment_intent,
    //       paymentStatus: session.payment_status,
    //       paidAt: new Date().toDateString(),
    //       trackingId,
    //     };

    //     if (session.payment_status === "paid") {
    //       const resultPayment = await paymentsCollection.insertOne(payment);
    //       res.send({
    //         success: true,
    //         modifyParcel: result,
    //         paymentInfo: resultPayment,
    //         trackingId,
    //         transactionId: session.payment_intent,
    //       });
    //     }
    //   }
    // });

    /* ==================================
    PAYMENT API's
    ================================== */
    app.get("/payments", verifyFBToken, async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.customerEmail = email;
        if (email !== req.token_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }

      const result = await paymentsCollection.find(query).toArray();
      res.send(result);
    });

    /* ==================================
    RIDER API's
    ================================== */
    app.get("/riders", async (req, res) => {
      const query = {};

      if (req.query?.status) {
        query.status = req.query?.status;
      }

      const result = await ridersCollection.find(query).toArray();
      res.send(result);
    });

    app.patch("/riders/:id", async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: { status },
      };

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
