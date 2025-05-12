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

    const coverImage = coverImageBase64;
    const overlayImage = overlayImageBase64;

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

    const coverImage = coverImageBase64;
    const cardImage = cardImageBase64;

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
          cover_image: event.cover_image,
          card_image: event.card_image,
          feedbacks: feedbackResult.rows,
        });
      }

      fullData.push({
        ...track,
        cover_image: track.cover_image,
        overlay_image: track.overlay_image,
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

// Eliminar Feedback
app.delete("/delete-feedback/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    // Verifica si el feedback existe
    const checkResult = await client.query(
      "SELECT 1 FROM feedbacks WHERE id = $1",
      [id]
    );

    if (checkResult.rowCount === 0) {
      return res.status(404).json({ error: "Feedback no encontrado" });
    }

    // Elimina el feedback
    await client.query("DELETE FROM feedbacks WHERE id = $1", [id]);

    res.status(200).json({ message: "Feedback eliminado correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
// Eliminar Evento (y sus feedbacks asociados)
app.delete("/delete-event/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    // Verifica si el evento existe
    const eventCheck = await client.query(
      "SELECT 1 FROM events WHERE id = $1",
      [id]
    );

    if (eventCheck.rowCount === 0) {
      return res.status(404).json({ error: "Evento no encontrado" });
    }

    // Elimina los feedbacks asociados
    await client.query("DELETE FROM feedbacks WHERE event_id = $1", [id]);

    // Elimina el evento
    await client.query("DELETE FROM events WHERE id = $1", [id]);

    res.status(200).json({
      message: "Evento y feedbacks asociados eliminados correctamente",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Eliminar Event Track (y sus eventos y feedbacks asociados)
app.delete("/delete-event-track/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    // Verifica si el event_track existe
    const trackCheck = await client.query(
      "SELECT 1 FROM event_tracks WHERE id = $1",
      [id]
    );

    if (trackCheck.rowCount === 0) {
      return res.status(404).json({ error: "Event track no encontrado" });
    }

    // Obtener todos los eventos asociados al event track
    const eventsResult = await client.query(
      "SELECT id FROM events WHERE event_track_id = $1",
      [id]
    );

    const eventIds = eventsResult.rows.map((row) => row.id);

    if (eventIds.length > 0) {
      // Eliminar feedbacks de todos esos eventos
      await client.query(
        "DELETE FROM feedbacks WHERE event_id = ANY($1::int[])",
        [eventIds]
      );

      // Eliminar eventos
      await client.query("DELETE FROM events WHERE id = ANY($1::int[])", [
        eventIds,
      ]);
    }

    // Eliminar el event track
    await client.query("DELETE FROM event_tracks WHERE id = $1", [id]);

    res.status(200).json({
      message:
        "Event track, eventos y feedbacks asociados eliminados correctamente",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/all-event-tracks", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM event_tracks");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/all-events", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM events");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/all-feedbacks", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM feedbacks");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/event-track-byid/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    // Buscar el event track
    const trackResult = await client.query(
      "SELECT * FROM event_tracks WHERE id = $1",
      [id]
    );
    if (trackResult.rowCount === 0) {
      return res.status(404).json({ error: "Event track no encontrado" });
    }
    const track = trackResult.rows[0];

    // Buscar eventos asociados
    const eventsResult = await client.query(
      "SELECT * FROM events WHERE event_track_id = $1",
      [id]
    );
    const events = [];

    for (const event of eventsResult.rows) {
      const feedbacksResult = await client.query(
        "SELECT * FROM feedbacks WHERE event_id = $1",
        [event.id]
      );
      events.push({ ...event, feedbacks: feedbacksResult.rows });
    }

    res.json({ ...track, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get("/event-byid/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const eventResult = await client.query(
      "SELECT * FROM events WHERE id = $1",
      [id]
    );
    if (eventResult.rowCount === 0) {
      return res.status(404).json({ error: "Evento no encontrado" });
    }
    const event = eventResult.rows[0];

    const feedbacksResult = await client.query(
      "SELECT * FROM feedbacks WHERE event_id = $1",
      [id]
    );

    res.json({ ...event, feedbacks: feedbacksResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/event-track-edit", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, name, description, coverImageBase64, overlayImageBase64 } =
      req.body;

    if (!id) {
      return res
        .status(400)
        .json({ error: "El ID del event_track es obligatorio" });
    }

    // Verifica si el event_track existe
    const checkResult = await client.query(
      "SELECT 1 FROM event_tracks WHERE id = $1",
      [id]
    );
    if (checkResult.rowCount === 0) {
      return res.status(404).json({ error: "Event track no encontrado" });
    }

    // Construir la consulta dinámica
    const fields = [];
    const values = [];
    let index = 1;

    if (name !== undefined) {
      fields.push(`name = $${++index}`);
      values.push(name);
    }

    if (description !== undefined) {
      fields.push(`description = $${++index}`);
      values.push(description);
    }

    if (coverImageBase64 !== undefined) {
      fields.push(`cover_image = $${++index}`);
      values.push(coverImageBase64);
    }

    if (overlayImageBase64 !== undefined) {
      fields.push(`overlay_image = $${++index}`);
      values.push(overlayImageBase64);
    }

    if (fields.length === 0) {
      return res
        .status(400)
        .json({ error: "No se proporcionó ningún campo para actualizar" });
    }

    const query = `UPDATE event_tracks SET ${fields.join(", ")} WHERE id = $1`;
    await client.query(query, [id, ...values]);

    res.status(200).json({ message: "Event track actualizado correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/event-edit", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      id,
      event_track_id,
      name,
      description,
      long_description,
      speakers,
      initial_date,
      final_date,
      location,
      capacity,
      available_seats,
      cover_image,
      card_image,
      event_track_name,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "El ID del evento es obligatorio" });
    }

    // Verifica si el evento existe
    const eventCheck = await client.query(
      "SELECT 1 FROM events WHERE id = $1",
      [id]
    );
    if (eventCheck.rowCount === 0) {
      return res.status(404).json({ error: "Evento no encontrado" });
    }

    // Si se proporciona un event_track_id, validarlo
    if (event_track_id !== undefined) {
      const trackCheck = await client.query(
        "SELECT 1 FROM event_tracks WHERE id = $1",
        [event_track_id]
      );
      if (trackCheck.rowCount === 0) {
        return res.status(400).json({ error: "event_track_id no válido" });
      }
    }

    // Construcción dinámica del UPDATE
    const fields = [];
    const values = [];
    let index = 1;

    const addField = (fieldName, value) => {
      if (value !== undefined) {
        fields.push(`${fieldName} = $${++index}`);
        values.push(value);
      }
    };

    addField("event_track_id", event_track_id);
    addField("name", name);
    addField("description", description);
    addField("long_description", long_description);
    addField("speakers", speakers ? JSON.parse(speakers) : undefined);
    addField("initial_date", initial_date);
    addField("final_date", final_date);
    addField("location", location);
    addField("capacity", capacity);
    addField("available_seats", available_seats);
    addField("cover_image", cover_image);
    addField("card_image", card_image);
    addField("event_track_name", event_track_name);

    if (fields.length === 0) {
      return res
        .status(400)
        .json({ error: "No se proporcionó ningún campo para actualizar" });
    }

    const query = `UPDATE events SET ${fields.join(", ")} WHERE id = $1`;
    await client.query(query, [id, ...values]);

    res.status(200).json({ message: "Evento actualizado correctamente" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
