import express from "express";
import pg from "pg";
import multer from "multer";
import path from "path";
import crypto from "crypto";
import { config } from "dotenv";
import { fileURLToPath } from "url";

config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas para servir imágenes
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// 📦 Multer config para guardar imágenes
const storage = multer.diskStorage({
  destination: path.join(__dirname, "uploads"),
  filename: (req, file, cb) => {
    const name = Date.now() + "-" + file.originalname.replace(/\s/g, "_");
    cb(null, name);
  },
});
const upload = multer({ storage });

/**
 * 1. Endpoint para BORRAR TODO
 */
app.delete("/wipe", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query(
      "DROP TABLE IF EXISTS recommended, feedbacks, events, event_tracks CASCADE;"
    );
    res.status(200).json({ message: "Base de datos limpiada" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * 2. Crear event track (con imagen real, no base64)
 */
app.post(
  "/event-track",
  upload.fields([{ name: "coverImage" }, { name: "overlayImage" }]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query(`
      CREATE TABLE IF NOT EXISTS event_tracks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        cover_image TEXT,
        overlay_image TEXT
      );
    `);

      const { name, description } = req.body;
      const coverImagePath = req.files["coverImage"]?.[0]?.filename || null;
      const overlayImagePath = req.files["overlayImage"]?.[0]?.filename || null;

      const result = await client.query(
        `INSERT INTO event_tracks (name, description, cover_image, overlay_image)
       VALUES ($1, $2, $3, $4) RETURNING id`,
        [name, description, coverImagePath, overlayImagePath]
      );

      res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

/**
 * 3. Crear evento (con imagen real)
 */
app.post(
  "/event",
  upload.fields([{ name: "coverImage" }, { name: "cardImage" }]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        event_track_id INTEGER REFERENCES event_tracks(id),
        name TEXT NOT NULL,
        description TEXT,
        long_description TEXT,
        speakers TEXT[],
        initial_date TIMESTAMP,
        final_date TIMESTAMP,
        location TEXT,
        capacity INTEGER,
        available_seats INTEGER,
        cover_image TEXT,
        card_image TEXT,
        event_track_name TEXT
      );
    `);

      const {
        eventTrackId,
        name,
        description,
        longDescription,
        speakers,
        initialDate,
        finalDate,
        location,
        capacity,
        availableSeats,
        eventTrackName,
      } = req.body;

      const coverImagePath = req.files["coverImage"]?.[0]?.filename || null;
      const cardImagePath = req.files["cardImage"]?.[0]?.filename || null;

      const result = await client.query(
        `INSERT INTO events (
        event_track_id, name, description, long_description, speakers,
        initial_date, final_date, location, capacity, available_seats,
        cover_image, card_image, event_track_name
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
      ) RETURNING id`,
        [
          eventTrackId,
          name,
          description,
          longDescription,
          speakers ? JSON.parse(speakers) : [],
          initialDate,
          finalDate,
          location,
          capacity,
          availableSeats,
          coverImagePath,
          cardImagePath,
          eventTrackName,
        ]
      );

      res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

/**
 * 4. Obtener full-data con URL de imágenes
 */
app.get("/full-data", async (req, res) => {
  const client = await pool.connect();
  try {
    const baseUrl = `${req.protocol}://${req.get("host")}/uploads`;

    const tracksResult = await client.query("SELECT * FROM event_tracks");
    const fullData = [];

    for (const track of tracksResult.rows) {
      const eventResult = await client.query(
        "SELECT * FROM events WHERE event_track_id = $1",
        [track.id]
      );

      const events = [];

      for (const event of eventResult.rows) {
        const feedbackResult = await client.query(
          "SELECT * FROM feedbacks WHERE event_id = $1",
          [event.id]
        );

        events.push({
          ...event,
          cover_image: event.cover_image
            ? `${baseUrl}/${event.cover_image}`
            : null,
          card_image: event.card_image
            ? `${baseUrl}/${event.card_image}`
            : null,
          feedbacks: feedbackResult.rows,
        });
      }

      fullData.push({
        ...track,
        cover_image: track.cover_image
          ? `${baseUrl}/${track.cover_image}`
          : null,
        overlay_image: track.overlay_image
          ? `${baseUrl}/${track.overlay_image}`
          : null,
        events,
      });
    }

    res.json(fullData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * 5. Otros endpoints se mantienen igual (feedback, hash, seat, recommended...)
 */
app.post("/feedback", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS feedbacks (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        event_id INTEGER REFERENCES events(id),
        stars INTEGER CHECK (stars BETWEEN 1 AND 5),
        comment TEXT
      );
    `);

    const { userId, eventId, stars, comment } = req.body;

    const result = await client.query(
      `INSERT INTO feedbacks (user_id, event_id, stars, comment)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, eventId, stars, comment]
    );

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/generate-hash", (req, res) => {
  const hash = crypto.randomBytes(16).toString("hex");
  res.json({ hash });
});

app.post("/event/:id/decrement-seat", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE events
       SET available_seats = GREATEST(available_seats - 1, 0)
       WHERE id = $1
       RETURNING available_seats`,
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/event/:id/increment-seat", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE events
       SET available_seats = available_seats + 1
       WHERE id = $1
       RETURNING available_seats`,
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/recommended", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS recommended (
        id SERIAL PRIMARY KEY,
        event_id INTEGER UNIQUE REFERENCES events(id)
      );
    `);

    const { eventId } = req.body;

    const eventResult = await client.query(
      "SELECT 1 FROM events WHERE id = $1",
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      return res.status(404).json({ error: "Evento no encontrado" });
    }

    await client.query(
      "INSERT INTO recommended (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [eventId]
    );

    res.status(201).json({ message: "Recomendado agregado" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/recommended", async (req, res) => {
  try {
    const result = await pool.query("SELECT event_id FROM recommended");
    const ids = result.rows.map((row) => row.event_id);
    res.json(ids);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
