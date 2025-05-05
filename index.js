import express from "express";
import pg from "pg";
import { config } from "dotenv";
import crypto from "crypto";

config();

const app = express();
app.use(express.json({ limit: "10mb" })); // Soporte para imágenes grandes

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// 🔹 Crear Event Track
app.post("/event-track", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_tracks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        cover_image BYTEA,
        overlay_image BYTEA
      );
    `);

    const { name, description, coverImageBase64, overlayImageBase64 } =
      req.body;

    const coverImageBuffer = Buffer.from(coverImageBase64, "base64");
    const overlayImageBuffer = Buffer.from(overlayImageBase64, "base64");

    const result = await client.query(
      `INSERT INTO event_tracks (name, description, cover_image, overlay_image)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description, coverImageBuffer, overlayImageBuffer]
    );

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 🔹 Obtener Event Track con imagenes en base64
app.get("/event-track/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM event_tracks WHERE id = $1",
      [req.params.id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Not found" });

    const track = result.rows[0];
    res.json({
      ...track,
      cover_image: track.cover_image?.toString("base64") ?? null,
      overlay_image: track.overlay_image?.toString("base64") ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Crear Evento
app.post("/event", async (req, res) => {
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
        cover_image BYTEA,
        card_image BYTEA,
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
      coverImageBase64,
      cardImageBase64,
      eventTrackName,
    } = req.body;

    const coverBuffer = Buffer.from(coverImageBase64, "base64");
    const cardBuffer = Buffer.from(cardImageBase64, "base64");

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
        speakers,
        initialDate,
        finalDate,
        location,
        capacity,
        availableSeats,
        coverBuffer,
        cardBuffer,
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

// 🔹 Añadir Feedback
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

// 🔹 Generar hash único
app.get("/generate-hash", (req, res) => {
  const hash = crypto.randomBytes(16).toString("hex");
  res.json({ hash });
});

// 🔹 Reducir en 1 available_seats
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

// 🔹 Aumentar en 1 available_seats
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
app.get("/", (req, res) => {
  res.send("Hello World");
});

app.get("/event-tracks", async (req, res) => {
  const client = await pool.connect();
  try {
    const trackResult = await client.query("SELECT * FROM event_tracks");

    const tracks = [];
    for (const track of trackResult.rows) {
      // Obtener eventos asociados
      const eventResult = await client.query(
        "SELECT * FROM events WHERE event_track_id = $1",
        [track.id]
      );

      const events = eventResult.rows.map((event) => ({
        ...event,
        cover_image: event.cover_image?.toString("base64") ?? null,
        card_image: event.card_image?.toString("base64") ?? null,
      }));

      tracks.push({
        ...track,
        cover_image: track.cover_image?.toString("base64") ?? null,
        overlay_image: track.overlay_image?.toString("base64") ?? null,
        events: events,
      });
    }

    res.json(tracks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/events", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM events");

    const events = result.rows.map((event) => ({
      ...event,
      cover_image: event.cover_image?.toString("base64") ?? null,
      card_image: event.card_image?.toString("base64") ?? null,
    }));

    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/feedbacks", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM feedbacks");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/full-data", async (req, res) => {
  const client = await pool.connect();
  try {
    // Asegurarse de que las tablas existan
    await client.query(`
      CREATE TABLE IF NOT EXISTS event_tracks (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        cover_image BYTEA,
        overlay_image BYTEA
      );

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
        cover_image BYTEA,
        card_image BYTEA,
        event_track_name TEXT
      );

      CREATE TABLE IF NOT EXISTS feedbacks (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        event_id INTEGER REFERENCES events(id),
        stars INTEGER CHECK (stars BETWEEN 1 AND 5),
        comment TEXT
      );
    `);

    const tracksResult = await client.query("SELECT * FROM event_tracks");

    const fullData = [];

    for (const track of tracksResult.rows) {
      // Eventos asociados al track
      const eventResult = await client.query(
        "SELECT * FROM events WHERE event_track_id = $1",
        [track.id]
      );

      const events = [];

      for (const event of eventResult.rows) {
        // Feedbacks asociados al evento
        const feedbackResult = await client.query(
          "SELECT * FROM feedbacks WHERE event_id = $1",
          [event.id]
        );

        events.push({
          ...event,
          cover_image: event.cover_image?.toString("base64") ?? null,
          card_image: event.card_image?.toString("base64") ?? null,
          feedbacks: feedbackResult.rows,
        });
      }

      fullData.push({
        ...track,
        cover_image: track.cover_image?.toString("base64") ?? null,
        overlay_image: track.overlay_image?.toString("base64") ?? null,
        events: events,
      });
    }

    res.json(fullData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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

    // Verifica si el evento existe
    const eventResult = await client.query(
      "SELECT 1 FROM events WHERE id = $1",
      [eventId]
    );

    if (eventResult.rowCount === 0) {
      return res.status(404).json({ error: "Evento no encontrado" });
    }

    // Intenta insertar (evita duplicados con UNIQUE)
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
    const result = await pool.query(`
      SELECT event_id FROM recommended
    `);

    const ids = result.rows.map((row) => row.event_id);
    res.json(ids); // Retorna una lista [1, 2, 3]
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("Server is running on port 3000");
});
