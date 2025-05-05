// index.js (o server.js)
import express from "express";
import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "dotenv";
import { fileURLToPath } from "url";

config();
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsPath = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath);
}

app.use("/uploads", express.static(uploadsPath));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Guardar imagen base64 en disco
function saveBase64Image(base64String) {
  if (!base64String) return null;

  const matches = base64String.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  if (!matches) return null;

  const ext = matches[1];
  const data = matches[2];
  const filename = `${Date.now()}-${crypto
    .randomBytes(4)
    .toString("hex")}.${ext}`;
  const filepath = path.join(uploadsPath, filename);

  fs.writeFileSync(filepath, Buffer.from(data, "base64"));
  return filename;
}

// Leer imagen y devolver base64
function readImageAsBase64(filename) {
  if (!filename) return null;
  const filepath = path.join(uploadsPath, filename);
  if (!fs.existsSync(filepath)) return null;

  const ext = path.extname(filename).slice(1);
  const mime = ext === "jpg" || ext === "jpeg" ? "jpeg" : ext;
  const base64 = fs.readFileSync(filepath).toString("base64");
  return `data:image/${mime};base64,${base64}`;
}

// 1. Wipe
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

// 2. Crear Event Track
app.post("/event-track", async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, coverImageBase64, overlayImageBase64 } =
      req.body;

    const coverImage = saveBase64Image(coverImageBase64);
    const overlayImage = saveBase64Image(overlayImageBase64);

    await client.query(`
      CREATE TABLE IF NOT EXISTS event_tracks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        cover_image TEXT,
        overlay_image TEXT
      );
    `);

    const result = await client.query(
      `INSERT INTO event_tracks (name, description, cover_image, overlay_image)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, description, coverImage, overlayImage]
    );

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. Crear Evento
app.post("/event", async (req, res) => {
  const client = await pool.connect();
  try {
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
      coverImageBase64,
      cardImageBase64,
    } = req.body;

    const coverImage = saveBase64Image(coverImageBase64);
    const cardImage = saveBase64Image(cardImageBase64);

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
        coverImage,
        cardImage,
        eventTrackName,
      ]
    );

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 4. Obtener Full Data
app.get("/full-data", async (req, res) => {
  const client = await pool.connect();
  try {
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
          cover_image: readImageAsBase64(event.cover_image),
          card_image: readImageAsBase64(event.card_image),
          feedbacks: feedbackResult.rows,
        });
      }

      fullData.push({
        ...track,
        cover_image: readImageAsBase64(track.cover_image),
        overlay_image: readImageAsBase64(track.overlay_image),
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

// 5. Feedback
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

// 6. Hash
app.get("/generate-hash", (req, res) => {
  const hash = crypto.randomBytes(16).toString("hex");
  res.json({ hash });
});

// 7. Seats
app.post("/event/:id/decrement-seat", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE events SET available_seats = GREATEST(available_seats - 1, 0)
       WHERE id = $1 RETURNING available_seats`,
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
      `UPDATE events SET available_seats = available_seats + 1
       WHERE id = $1 RETURNING available_seats`,
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Recomendados
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
