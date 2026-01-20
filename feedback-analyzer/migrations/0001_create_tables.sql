-- Feedback table to store all incoming feedback
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,           -- e.g., 'discord', 'github', 'support', 'twitter', 'email'
    source_id TEXT,                 -- original ID from the source platform
    author TEXT,                    -- who submitted the feedback
    content TEXT NOT NULL,          -- the actual feedback text
    sentiment TEXT,                 -- 'positive', 'negative', 'neutral'
    sentiment_score REAL,           -- numerical score -1 to 1
    urgency TEXT,                   -- 'low', 'medium', 'high', 'critical'
    themes TEXT,                    -- JSON array of extracted themes
    summary TEXT,                   -- AI-generated summary
    analyzed_at TEXT,               -- when AI analysis was performed
    created_at TEXT DEFAULT (datetime('now')),
    metadata TEXT                   -- JSON for any additional source-specific data
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);
CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON feedback(sentiment);
CREATE INDEX IF NOT EXISTS idx_feedback_urgency ON feedback(urgency);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);

-- Themes table for aggregated theme tracking
CREATE TABLE IF NOT EXISTS themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    count INTEGER DEFAULT 1,
    last_seen TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_themes_count ON themes(count DESC);
