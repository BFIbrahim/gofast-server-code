const express = require('express')
const cors = require('cors')
const dotenv = require('dotenv')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");

dotenv.config()

const stripe = require('stripe')(process.env.PAYMENT_STRIPE_KEY)

const app = express()
const port = process.env.PORT || 5000

app.use(cors())
app.use(express.json())

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, 'base64'.toString('utf8'))
const serviceAccount = JSON.parse(decodedKey)
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});




const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.0crvfc6.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // await client.connect();

        const db = client.db('parcelDB')
        const parcelCollection = db.collection('parcels')
        const paymentCollection = db.collection('payments')
        const usersCollections = db.collection('users')
        const ridersCollections = db.collection('riders')

        const verifyToken = async (req, res, next) => {
            const authHeaders = req.headers.authorization
            console.log(req.headers)

            if (!authHeaders) {
                res.status(401).send({ message: 'Unauthorized access' })
            }

            const token = authHeaders.split(' ')[1]
            if (!token) {
                res.status(401).send({ message: 'Unauthorized access' })
            }

            try {
                const decoded = await admin.auth().verifyIdToken(token)
                req.decoded = decoded

            } catch (error) {
                res.status(403).send({ message: 'Forbidden access' })
            }

            next()
        }

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email
            const query = { email }
            const user = await usersCollections.findOne(query)

            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'Unauthorized access' })
            }

            next()
        }

        app.post('/users', async (req, res) => {
            const email = req.body.email
            const userExits = await usersCollections.findOne({ email })

            if (userExits) {
                return res.status(200).send({ message: 'user already exist', inserted: false })
            }

            const user = req.body
            const result = await usersCollections.insertOne(user)
            res.send(result)
        })

        app.get('/users/:email/role', async (req, res) => {
            try {
                const email = req.params.email
                if (!email) {
                    res.send({ message: 'Email is required' })
                }

                const user = await usersCollections.findOne({ email })

                if (!user) {
                    res.send({ message: 'User not found' })
                }

                res.send({ role: user.role || 'user' })
            } catch (error) {
                console.log(error)
                res.send({ message: 'Failed to get role' })
            }
        })

        app.get('/users/search', async (req, res) => {
            const emailQuery = req.query.email

            if (!emailQuery) {
                return res.send({ message: 'Missing email query' })

            }

            const regex = new RegExp(emailQuery, 'i')

            try {
                const users = await usersCollections
                    .find({ email: { $regex: regex } })
                    .project({ email: 1, createdAt: 1, role: 1 })
                    .limit(10)
                    .toArray()

                res.send(users)
            } catch (error) {
                console.log(error)
                res.send({ message: 'Error in searching users' })
            }
        })

        app.patch('/users/:id/role', async (req, res) => {
            const { id } = req.params
            const { role } = req.body

            if (!['admin', 'user'].includes(role)) {
                res.send({ message: 'Invalid Role' })
            }

            try {
                const result = await usersCollections.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { role } }
                )

                res.send({ message: `user role updated to ${role}`, result })
            } catch (error) {
                console.log(error)
                res.send({ message: `can't update user role` })
            }
        })

        app.get('/parcels', verifyToken, async (req, res) => {
            try {
                const email = req.query.email;

                const query = email ? { userEmail: email } : {}
                const options = {
                    sort: {
                        createdAt: -1
                    }
                }

                const parcels = await parcelCollection.find(query, options).toArray()
                res.send(parcels)
            } catch (error) {
                console.log(error)
                express.response.status.send({ message: 'failed to get parcels' })
            }
        })

        app.post('/parcels', async (req, res) => {
            try {
                const newParcel = req.body
                const result = await parcelCollection.insertOne(newParcel)
                res.status(201).send(result)
            } catch (error) {
                console.error('The Error id', error)
                res.status(500).send({ message: 'failed to create new parcel' })
            }
        })

        app.get('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id
                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) })

                res.send(parcel)
            } catch (error) {
                console.log(error)
            }
        })

        app.delete('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id

                const result = await parcelCollection.deleteOne({ _id: new ObjectId(id) })

                res.send(result)
            } catch (error) {
                console.log(error)
                res.send({ message: 'failed to Delete the parcel' })
            }
        })

        app.post('/riders', async (req, res) => {
            const rider = req.body;

            // check if this email already applied
            const existing = await ridersCollections.findOne({ email: rider.email });

            if (existing) {
                return res.send({ message: "already_applied" });
            }

            rider.status = rider.status || "pending";
            const result = await ridersCollections.insertOne(rider);
            res.send(result);
        });


        app.get('/riders', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const riders = await ridersCollections
                    .find()
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(riders);
            } catch (error) {
                console.log(error);
                res.status(500).send({ message: "Failed to get riders" });
            }
        });

        app.patch('/assign-rider/:parcelId', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const parcelId = req.params.parcelId;
                const { riderId } = req.body;

                // Find rider by id
                const rider = await ridersCollections.findOne({
                    _id: new ObjectId(riderId)
                });

                if (!rider) {
                    return res.status(404).send({ message: "Rider not found" });
                }

                // Update parcel and set rider email
                const parcelUpdate = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            status: "Assigned Rider",
                            assignedRider: rider.email     // <-- SET EMAIL HERE
                        }
                    }
                );

                // Update rider work status
                const riderUpdate = await ridersCollections.updateOne(
                    { _id: new ObjectId(riderId) },
                    {
                        $set: { workStatus: "busy" }
                    }
                );

                res.send({
                    success: true,
                    message: "Rider assigned successfully",
                    parcelUpdate,
                    riderUpdate
                });

            } catch (error) {
                console.log(error);
                res.status(500).send({ message: "Failed to assign rider" });
            }
        });

        app.get('/parcels/pending/:email', verifyToken, async (req, res) => {
            try {
                const email = req.params.email;

                const parcels = await parcelCollection
                    .find({
                        assignedRider: email,
                        status: "Assigned Rider"
                    })
                    .toArray();

                res.send(parcels);

            } catch (error) {
                console.log(error);
                res.status(500).send({ message: "Failed to fetch pending parcels" });
            }
        });


        app.get('/riders/pending', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const pendingRiders = await ridersCollections.find({ status: 'pending' }).toArray()

                res.send(pendingRiders)
            } catch (error) {
                console.log(error)
                res.send({ message: 'filed to load pending riders' })
            }
        })

        app.get('/riders/approved', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const result = await ridersCollections
                    .find({ status: "approved" })
                    .toArray();

                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });


        app.patch('/riders/update/:id', verifyAdmin, verifyToken, async (req, res) => {
            try {
                const id = req.params.id;
                const { status } = req.body;

                const result = await ridersCollections.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status } }
                );

                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });


        app.patch('/riders/update-status/:id', verifyToken, verifyAdmin, async (req, res) => {
            try {
                const id = req.params.id;
                const { action, email } = req.body;

                if (!action || !["approve", "decline"].includes(action)) {
                    return res.status(400).send({ message: "Invalid action" });
                }

                const newStatus = action === "approve" ? "approved" : "declined";

                // update rider status
                const result = await ridersCollections.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: newStatus } }
                );

                // if approved → update user role to rider
                if (newStatus === "approved") {
                    const roleResult = await usersCollections.updateOne(
                        { email: email },
                        { $set: { role: "rider" } }   // FIXED !!
                    );

                    console.log("Role Updated:", roleResult.matchedCount);
                }

                res.send({ success: true, status: newStatus, result });
            } catch (error) {
                console.error("Status update error:", error);
                res.status(500).send({ message: "Status update failed" });
            }
        });


        app.post('/tracking', async (req, res) => {
            const { tracking_id, parcel_id, status, message, update_by = '' } = req.body

            const log = {
                tracking_id,
                parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
                status,
                message,
                time: new Date(),
                update_by
            }

            const result = await trackingCollection.insertOne(log);
            res.send({ success: true, insertedId: result.insertedId })


        })

        app.get('/payments', verifyToken, async (req, res) => {


            try {
                const userEmail = req.query.email

                console.log(req.decoded.email)

                if (req.decoded.email !== userEmail) {
                    res.status(403).send({ message: 'Forbidden access' })
                }

                const query = userEmail ? { email: userEmail } : {}
                const options = { sort: { paidAt: -1 } }

                const payments = await paymentCollection.find(query, options).toArray()
                res.send(payments)

            } catch (error) {
                console.log(error)
                res.send({ message: 'getting payments failed' })
            }
        })

        app.post('/payments', async (req, res) => {
            try {
                const { parcelId, email, amount, paymentMethod, transectionId } = req.body

                const updateResult = await parcelCollection.updateOne(
                    { _id: new ObjectId(parcelId) },
                    {
                        $set: {
                            paymentStatus: 'paid'
                        }
                    }

                )

                if (updateResult.modifiedCount === 0) {
                    return res.send({ message: 'parcel not found ot already paid' })
                }

                const paymentDoc = {
                    parcelId,
                    email,
                    amount,
                    paymentMethod,
                    transectionId,
                    paidAtString: new Date().toISOString(),
                    paidAt: new Date()
                }

                const paymentResult = await paymentCollection.insertOne(paymentDoc)

                res.send({
                    message: 'payment recorded and parcel',
                    insertedId: paymentResult.insertedId
                })


            } catch (error) {

            }
        })

        app.post('/create-payment-intent', async (req, res) => {

            const amountInCents = req.body.amountInCents

            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents,
                    currency: 'usd',
                    payment_method_types: ['card']
                })
                res.json({ clientSecret: paymentIntent.client_secret })
            } catch (error) {
                res.json({ error: error.message })
            }
        })

        // await client.db("admin").command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send(`Server is Running on port`)
})

app.listen(port, () => {
    console.log(`server is Running on port ${port}`)
})