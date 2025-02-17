const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const axios = require("axios");
const pool = require("./config/db");

dotenv.config();
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");

// ✅ Initialize WebSocket Server Properly
const io = new Server(server, {
  cors: {
    origin: [
      "http://127.0.0.1:5500",
      "http://127.0.0.1:5501",
      "http://localhost:5500",
      "http://localhost:5501",
      "http://localhost:3000",
      process.env.FRONTEND_URL || "*",
    ],
    methods: ["GET", "POST"],
  },
});

// ✅ Express Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Serve Static Files
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));

// ✅ CORS Configuration
app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        "http://127.0.0.1:5500",
        "http://127.0.0.1:5501",
        "http://localhost:5500",
        "http://localhost:5501",
        "http://localhost:3000",
        process.env.FRONTEND_URL || "*",
      ];
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS Not Allowed"));
      }
    },
    methods: "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);

// ✅ WebSocket Events (Fixed Connection Issues)
io.on("connection", (socket) => {
  console.log("✅ WebSocket Connected");

  socket.on("warning", (message) => {
    console.log("⚠ Warning:", message);
    socket.broadcast.emit("warning", message);
  });

  socket.on("examEnd", (message) => {
    console.log("🚨 Exam End:", message);
    socket.broadcast.emit("examEnd", message);
  });

  socket.on("disconnect", () => {
    console.log("❌ User disconnected from WebSocket");
  });
});

// ✅ API Routes
const authRoutes = require("./routes/authRoutes");
const supportRoutes = require("./routes/supportRoutes");
const contactRoutes = require("./routes/contactRoutes");

app.use("/api/auth", authRoutes);
app.use("/support", supportRoutes);
app.use("/api", contactRoutes);
app.use("/api", authRoutes);

// ✅ Serve Frontend Pages
app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "index.html")));
app.get("/dashboard", (req, res) =>
  res.sendFile(path.join(frontendPath, "pages/userDash.html"))
);
app.get("/reset-password", (req, res) =>
  res.sendFile(path.join(frontendPath, "pages/reset-password.html"))
);

// ✅ Fetch Questions API
app.get("/api/questions", async (req, res) => {
  try {
    const result = await pool.query(`
        SELECT 
          question_id, 
          question_description, 
          answer1, 
          answer2, 
          answer3, 
          answer4
        FROM Questions
    `);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error fetching questions:", error);
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

// ✅ Submit Test Results
app.post("/api/submitTestResults", async (req, res) => {
  const { user_id, results } = req.body;

  console.log("✅ Received Test Submission for User ID:", user_id);
  console.log("✅ Test Results Data:", JSON.stringify(results, null, 2));

  if (!user_id || !results || !Array.isArray(results)) {
    return res.status(400).json({ error: "User ID and test results are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const attemptedResults = results.filter((result) => result.is_attempt === true);
    const currentDate = new Date();

    for (const result of attemptedResults) {
      await client.query(
        "INSERT INTO attempt_questions (user_id, question_id, option, date) VALUES ($1, $2, $3, $4)",
        [user_id, result.question_id, result.user_option, currentDate]
      );
    }

    await client.query("COMMIT");

    console.log("[LOG] Calling /api/generate-result...");
    const response = await axios.post(
      "http://localhost:5000/api/generate-result",
      { user_id, result_date: currentDate },
      { headers: { "Content-Type": "application/json" }, timeout: 5000 }
    );

    res.json({ message: "Test results saved successfully.", redirect: response.data.redirect });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error saving test results:", error);
    res.status(500).json({ error: "Error saving test results" });
  } finally {
    client.release();
  }
});

// ✅ Generate Result API
app.post("/api/generate-result", async (req, res) => {
  const { user_id, result_date } = req.body;
  console.log("📡 Generating results for User ID:", user_id);
  console.log("📌 Received Result Date:", result_date);

  try {
      const userResult = await pool.query("SELECT category FROM users WHERE id = $1", [user_id]);

      if (userResult.rows.length === 0) {
          console.error("❌ User not found in the database.");
          return res.status(404).json({ message: "User not found" });
      }

      const category_id = userResult.rows[0].category;
      const questionPaperResult = await pool.query("SELECT total_questions FROM question_paper WHERE id = $1", [1]);

      if (questionPaperResult.rows.length === 0) {
          console.error("❌ Question paper not found.");
          return res.status(404).json({ message: "Question paper not found" });
      }

      const totalQuestions = questionPaperResult.rows[0].total_questions;

      // Fetch attempted questions
      const attempts = await pool.query(
          `SELECT a.question_id, a.option AS marked_option, q.correct_answer, q.marks, q.negative_marks
           FROM attempt_questions a
           INNER JOIN questions q ON a.question_id = q.question_id
           WHERE a.user_id = $1 AND a.date = $2;`,
          [user_id, result_date]
      );

      if (attempts.rows.length === 0) {
          console.error("❌ No attempts found for the user.");
          return res.status(404).json({ message: "No attempts found for the user." });
      }

      let correctAnswers = 0, incorrectAnswers = 0, totalScore = 0, attemptedQuestions = attempts.rows.length;

      attempts.rows.forEach((attempt) => {
          if (attempt.marked_option === attempt.correct_answer) {
              correctAnswers++;
              totalScore += attempt.marks;
          } else {
              incorrectAnswers++;
              totalScore -= Math.abs(attempt.negative_marks);
          }
      });

      totalScore = (correctAnswers * 4) - (incorrectAnswers * 1);

      // Insert result into results table
      const resultData = await pool.query(
          `INSERT INTO results (user_id, total_questions, correct_answers, incorrect_answers, total_score, category_id, attempted_questions, result_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *;`,
          [user_id, totalQuestions, correctAnswers, incorrectAnswers, totalScore, category_id, attemptedQuestions, result_date]
      );

      console.log("✅ Result inserted successfully:", resultData.rows[0]);

      const queryParams = new URLSearchParams(resultData.rows[0]).toString();
      const redirectUrl = `http://127.0.0.1:5500/Frontend/pages/result.html?${queryParams}`;
      
      console.log("🔄 Redirecting user to:", redirectUrl);
      return res.json({ redirect: redirectUrl });

  } catch (error) {
      console.error("❌ Error generating result:", error);
      return res.status(500).json({ error: "Internal server error." });
  }
});


// ✅ Catch-All for Undefined Routes
app.use((req, res) => res.status(404).json({ message: "Route not found" }));

// ✅ Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  try {
    await pool.connect();
    console.log(`✅ Database connected & Server running on port ${PORT}`);
  } catch (error) {
    console.error("❌ Database connection error:", error);
  }
});

