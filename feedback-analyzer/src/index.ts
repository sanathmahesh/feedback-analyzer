import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
	DB: D1Database;
	AI: Ai;
	CACHE: KVNamespace;
};

type Feedback = {
	id?: number;
	source: string;
	source_id?: string;
	author?: string;
	content: string;
	sentiment?: string;
	sentiment_score?: number;
	urgency?: string;
	themes?: string;
	summary?: string;
	analyzed_at?: string;
	created_at?: string;
	metadata?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for all routes
app.use('/*', cors());

// Health check
app.get('/api/health', (c) => {
	return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize database tables
app.post('/api/init', async (c) => {
	try {
		await c.env.DB.exec(`
			CREATE TABLE IF NOT EXISTS feedback (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				source TEXT NOT NULL,
				source_id TEXT,
				author TEXT,
				content TEXT NOT NULL,
				sentiment TEXT,
				sentiment_score REAL,
				urgency TEXT,
				themes TEXT,
				summary TEXT,
				analyzed_at TEXT,
				created_at TEXT DEFAULT (datetime('now')),
				metadata TEXT
			);
		`);
		await c.env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);`);
		await c.env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON feedback(sentiment);`);
		await c.env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_urgency ON feedback(urgency);`);
		await c.env.DB.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);`);
		return c.json({ success: true, message: 'Database initialized' });
	} catch (error) {
		return c.json({ success: false, error: String(error) }, 500);
	}
});

// Analyze feedback with Workers AI
async function analyzeFeedback(ai: Ai, content: string): Promise<{
	sentiment: string;
	sentiment_score: number;
	urgency: string;
	themes: string[];
	summary: string;
}> {
	const prompt = `Analyze the following customer feedback and provide a JSON response with these fields:
- sentiment: one of "positive", "negative", or "neutral"
- sentiment_score: a number from -1 (very negative) to 1 (very positive)
- urgency: one of "low", "medium", "high", or "critical"
- themes: an array of 1-3 key themes or topics mentioned (e.g., ["performance", "pricing", "documentation"])
- summary: a one-sentence summary of the feedback

Feedback: "${content}"

Respond with ONLY valid JSON, no other text.`;

	try {
		const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
			prompt,
			max_tokens: 300,
		});

		// Extract JSON from response
		const responseText = (response as { response: string }).response || '';
		const jsonMatch = responseText.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			return {
				sentiment: parsed.sentiment || 'neutral',
				sentiment_score: parsed.sentiment_score || 0,
				urgency: parsed.urgency || 'medium',
				themes: parsed.themes || [],
				summary: parsed.summary || content.substring(0, 100),
			};
		}
	} catch (error) {
		console.error('AI analysis error:', error);
	}

	// Fallback if AI fails
	return {
		sentiment: 'neutral',
		sentiment_score: 0,
		urgency: 'medium',
		themes: [],
		summary: content.substring(0, 100),
	};
}

// Submit new feedback
app.post('/api/feedback', async (c) => {
	try {
		const body = await c.req.json<Feedback>();

		if (!body.content || !body.source) {
			return c.json({ error: 'content and source are required' }, 400);
		}

		// Analyze with AI
		const analysis = await analyzeFeedback(c.env.AI, body.content);

		// Insert into database
		const result = await c.env.DB.prepare(`
			INSERT INTO feedback (source, source_id, author, content, sentiment, sentiment_score, urgency, themes, summary, analyzed_at, metadata)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
		`).bind(
			body.source,
			body.source_id || null,
			body.author || 'Anonymous',
			body.content,
			analysis.sentiment,
			analysis.sentiment_score,
			analysis.urgency,
			JSON.stringify(analysis.themes),
			analysis.summary,
			body.metadata || null
		).run();

		// Invalidate cache
		await c.env.CACHE.delete('dashboard_stats');
		await c.env.CACHE.delete('recent_feedback');

		return c.json({
			success: true,
			id: result.meta.last_row_id,
			analysis,
		});
	} catch (error) {
		return c.json({ error: String(error) }, 500);
	}
});

// Get all feedback with optional filters
app.get('/api/feedback', async (c) => {
	try {
		const source = c.req.query('source');
		const sentiment = c.req.query('sentiment');
		const urgency = c.req.query('urgency');
		const limit = parseInt(c.req.query('limit') || '50');
		const offset = parseInt(c.req.query('offset') || '0');

		let query = 'SELECT * FROM feedback WHERE 1=1';
		const params: (string | number)[] = [];

		if (source) {
			query += ' AND source = ?';
			params.push(source);
		}
		if (sentiment) {
			query += ' AND sentiment = ?';
			params.push(sentiment);
		}
		if (urgency) {
			query += ' AND urgency = ?';
			params.push(urgency);
		}

		query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
		params.push(limit, offset);

		const result = await c.env.DB.prepare(query).bind(...params).all();

		return c.json({
			feedback: result.results.map((row: Record<string, unknown>) => ({
				...row,
				themes: row.themes ? JSON.parse(row.themes as string) : [],
			})),
			total: result.results.length,
		});
	} catch (error) {
		return c.json({ error: String(error) }, 500);
	}
});

// Get dashboard statistics
app.get('/api/stats', async (c) => {
	try {
		// Check cache first
		const cached = await c.env.CACHE.get('dashboard_stats');
		if (cached) {
			return c.json(JSON.parse(cached));
		}

		// Total feedback count
		const totalResult = await c.env.DB.prepare(
			'SELECT COUNT(*) as count FROM feedback'
		).first<{ count: number }>();

		// Sentiment breakdown
		const sentimentResult = await c.env.DB.prepare(`
			SELECT sentiment, COUNT(*) as count
			FROM feedback
			GROUP BY sentiment
		`).all();

		// Source breakdown
		const sourceResult = await c.env.DB.prepare(`
			SELECT source, COUNT(*) as count
			FROM feedback
			GROUP BY source
			ORDER BY count DESC
		`).all();

		// Urgency breakdown
		const urgencyResult = await c.env.DB.prepare(`
			SELECT urgency, COUNT(*) as count
			FROM feedback
			GROUP BY urgency
		`).all();

		// Theme frequency (aggregate from all feedback)
		const themesResult = await c.env.DB.prepare(
			'SELECT themes FROM feedback WHERE themes IS NOT NULL'
		).all();

		const themeCount: Record<string, number> = {};
		for (const row of themesResult.results) {
			try {
				const themes = JSON.parse((row as { themes: string }).themes || '[]');
				for (const theme of themes) {
					themeCount[theme] = (themeCount[theme] || 0) + 1;
				}
			} catch {
				// Skip invalid JSON
			}
		}

		// Sort themes by count
		const topThemes = Object.entries(themeCount)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([name, count]) => ({ name, count }));

		// Average sentiment score
		const avgSentimentResult = await c.env.DB.prepare(
			'SELECT AVG(sentiment_score) as avg FROM feedback'
		).first<{ avg: number }>();

		// Recent trend (last 7 days)
		const trendResult = await c.env.DB.prepare(`
			SELECT date(created_at) as date, COUNT(*) as count,
				   AVG(sentiment_score) as avg_sentiment
			FROM feedback
			WHERE created_at >= date('now', '-7 days')
			GROUP BY date(created_at)
			ORDER BY date ASC
		`).all();

		const stats = {
			total: totalResult?.count || 0,
			sentiment: Object.fromEntries(
				sentimentResult.results.map((r: Record<string, unknown>) => [r.sentiment, r.count])
			),
			sources: Object.fromEntries(
				sourceResult.results.map((r: Record<string, unknown>) => [r.source, r.count])
			),
			urgency: Object.fromEntries(
				urgencyResult.results.map((r: Record<string, unknown>) => [r.urgency, r.count])
			),
			topThemes,
			averageSentiment: avgSentimentResult?.avg || 0,
			trend: trendResult.results,
		};

		// Cache for 5 minutes
		await c.env.CACHE.put('dashboard_stats', JSON.stringify(stats), { expirationTtl: 300 });

		return c.json(stats);
	} catch (error) {
		return c.json({ error: String(error) }, 500);
	}
});

// Generate AI summary of all feedback
app.get('/api/summary', async (c) => {
	try {
		// Get recent feedback for summary
		const result = await c.env.DB.prepare(`
			SELECT content, sentiment, urgency, themes
			FROM feedback
			ORDER BY created_at DESC
			LIMIT 20
		`).all();

		if (result.results.length === 0) {
			return c.json({ summary: 'No feedback available yet.' });
		}

		const feedbackText = result.results
			.map((r: Record<string, unknown>, i: number) => `${i + 1}. [${r.sentiment}/${r.urgency}] ${r.content}`)
			.join('\n');

		const prompt = `You are a product manager analyzing customer feedback. Based on the following feedback items, provide a concise executive summary (2-3 paragraphs) covering:
1. Overall sentiment and key concerns
2. The most urgent issues that need attention
3. Recommended priorities for the product team

Feedback:
${feedbackText}

Provide a helpful, actionable summary:`;

		const response = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
			prompt,
			max_tokens: 500,
		});

		return c.json({
			summary: (response as { response: string }).response || 'Unable to generate summary.',
			feedbackCount: result.results.length,
		});
	} catch (error) {
		return c.json({ error: String(error) }, 500);
	}
});

// Reset database (clear all feedback)
app.post('/api/reset', async (c) => {
	try {
		await c.env.DB.prepare('DELETE FROM feedback').run();
		await c.env.CACHE.delete('dashboard_stats');
		return c.json({ success: true, message: 'All feedback cleared' });
	} catch (error) {
		return c.json({ error: String(error) }, 500);
	}
});

// Seed mock data (clears existing data first)
app.post('/api/seed', async (c) => {
	// Clear existing data first to prevent duplicates
	try {
		await c.env.DB.prepare('DELETE FROM feedback').run();
	} catch (e) {
		// Table might not exist yet, that's ok
	}

	const mockFeedback: Feedback[] = [
		// Discord feedback
		{
			source: 'discord',
			author: 'developer_jane',
			content: "The new Workers AI integration is amazing! I was able to build a sentiment analysis tool in under an hour. Documentation was clear and examples were helpful.",
		},
		{
			source: 'discord',
			author: 'cloudflare_fan',
			content: "Having issues with D1 database connections timing out intermittently. Anyone else experiencing this? It's affecting our production app.",
		},
		{
			source: 'discord',
			author: 'startup_dev',
			content: "Wrangler CLI keeps crashing when I try to deploy. Error message isn't helpful at all. Spent 2 hours debugging this.",
		},
		// GitHub Issues
		{
			source: 'github',
			author: 'open-source-contributor',
			content: "Feature request: Please add support for WebSocket connections in Workers. This would enable real-time applications without workarounds.",
		},
		{
			source: 'github',
			author: 'enterprise_user',
			content: "Bug: KV namespace not syncing across regions. Data written in US is not immediately available in EU. This is blocking our global deployment.",
		},
		{
			source: 'github',
			author: 'security_researcher',
			content: "Security concern: The default CORS settings are too permissive. Should have stricter defaults with opt-in for relaxed policies.",
		},
		// Support Tickets
		{
			source: 'support',
			author: 'enterprise_client',
			content: "URGENT: Our Workers are returning 502 errors for 15% of requests since the last platform update. Revenue impact is significant. Need immediate assistance.",
		},
		{
			source: 'support',
			author: 'small_business',
			content: "Billing question: We were charged for Workers usage but our dashboard shows zero requests. Can someone explain the discrepancy?",
		},
		{
			source: 'support',
			author: 'new_customer',
			content: "Great onboarding experience! The free tier was perfect for prototyping. Just upgraded to paid plan. Quick suggestion: add more code templates.",
		},
		// Twitter/X
		{
			source: 'twitter',
			author: '@tech_reviewer',
			content: "Just tried @Cloudflare Workers for the first time. Deploy times are incredible - under 1 second! The future of serverless is here.",
		},
		{
			source: 'twitter',
			author: '@frustrated_dev',
			content: "@Cloudflare your documentation for Pages is outdated. Half the examples don't work. Please update or add version numbers.",
		},
		{
			source: 'twitter',
			author: '@startup_cto',
			content: "Moved our entire API from AWS Lambda to @Cloudflare Workers. 60% cost reduction and better latency. Highly recommend!",
		},
		// Email
		{
			source: 'email',
			author: 'potential_customer@company.com',
			content: "We're evaluating Cloudflare for our enterprise needs. Main concern is the 128MB memory limit for Workers. Are there plans to increase this?",
		},
		{
			source: 'email',
			author: 'partner@agency.com',
			content: "Our agency builds on Cloudflare. Would love better white-labeling options for the dashboard. Clients want their branding.",
		},
		// Community Forum
		{
			source: 'forum',
			author: 'community_helper',
			content: "Tutorial suggestion: Need more content on debugging Workers in production. The current logging is minimal and hard to work with.",
		},
		{
			source: 'forum',
			author: 'power_user',
			content: "Been using Cloudflare for 3 years. The R2 storage is a game-changer. Zero egress fees saved us thousands monthly.",
		},
		{
			source: 'forum',
			author: 'new_developer',
			content: "Confused about the difference between Workers and Pages. Documentation assumes prior knowledge. Need a clearer comparison guide.",
		},
		{
			source: 'discord',
			author: 'ml_engineer',
			content: "Workers AI model selection is limited. Would love to see more specialized models for code generation and analysis.",
		},
		{
			source: 'github',
			author: 'performance_tester',
			content: "Noticed cold start times increased after recent update. P99 latency went from 50ms to 200ms. Can you investigate?",
		},
		{
			source: 'support',
			author: 'migration_customer',
			content: "Migrating from Vercel. The process is smooth but missing import tool for environment variables. Had to manually copy 50+ vars.",
		},
	];

	try {
		let imported = 0;
		for (const item of mockFeedback) {
			const analysis = await analyzeFeedback(c.env.AI, item.content);

			await c.env.DB.prepare(`
				INSERT INTO feedback (source, source_id, author, content, sentiment, sentiment_score, urgency, themes, summary, analyzed_at, metadata)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
			`).bind(
				item.source,
				null,
				item.author || 'Anonymous',
				item.content,
				analysis.sentiment,
				analysis.sentiment_score,
				analysis.urgency,
				JSON.stringify(analysis.themes),
				analysis.summary,
				null
			).run();

			imported++;
		}

		// Invalidate cache
		await c.env.CACHE.delete('dashboard_stats');

		return c.json({ success: true, imported });
	} catch (error) {
		return c.json({ error: String(error) }, 500);
	}
});

// Dashboard HTML - Modern SaaS Design
const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pulse | Customer Feedback Intelligence</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
            --bg-base: #09090b;
            --bg-surface: #18181b;
            --bg-elevated: #27272a;
            --bg-hover: #3f3f46;
            --border: rgba(255,255,255,0.08);
            --border-strong: rgba(255,255,255,0.12);
            --text: #fafafa;
            --text-secondary: #a1a1aa;
            --text-muted: #71717a;
            --accent: #a855f7;
            --accent-soft: rgba(168,85,247,0.15);
            --positive: #22c55e;
            --positive-soft: rgba(34,197,94,0.15);
            --negative: #ef4444;
            --negative-soft: rgba(239,68,68,0.15);
            --warning: #f59e0b;
            --warning-soft: rgba(245,158,11,0.15);
            --gradient: linear-gradient(135deg, #a855f7 0%, #6366f1 100%);
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg-base);
            color: var(--text);
            line-height: 1.6;
            font-size: 14px;
            -webkit-font-smoothing: antialiased;
            min-height: 100vh;
        }

        /* Layout */
        .app { display: flex; min-height: 100vh; }

        .sidebar {
            width: 260px;
            background: var(--bg-surface);
            border-right: 1px solid var(--border);
            padding: 24px 16px;
            position: fixed;
            height: 100vh;
            display: flex;
            flex-direction: column;
            z-index: 50;
        }

        .main {
            flex: 1;
            margin-left: 260px;
            padding: 32px 40px;
            background: var(--bg-base);
            min-height: 100vh;
        }

        /* Logo */
        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 0 12px;
            margin-bottom: 32px;
        }

        .logo-icon {
            width: 36px;
            height: 36px;
            background: var(--gradient);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(168,85,247,0.3);
        }

        .logo-icon svg { width: 20px; height: 20px; color: white; }
        .logo-text { font-weight: 700; font-size: 18px; letter-spacing: -0.5px; }

        /* Navigation */
        .nav-section { margin-bottom: 28px; }
        .nav-label {
            font-size: 11px;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 0.8px;
            padding: 0 12px;
            margin-bottom: 12px;
        }

        .nav-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 12px;
            border-radius: 8px;
            color: var(--text-secondary);
            cursor: pointer;
            transition: all 0.2s ease;
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 4px;
        }

        .nav-item:hover {
            background: var(--bg-elevated);
            color: var(--text);
        }

        .nav-item.active {
            background: var(--accent-soft);
            color: var(--accent);
        }

        .nav-item svg { width: 18px; height: 18px; }

        .source-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .source-dot.discord { background: #5865F2; }
        .source-dot.github { background: #f0f0f0; }
        .source-dot.support { background: #a855f7; }
        .source-dot.twitter { background: #1da1f2; }
        .source-dot.email { background: #ea580c; }
        .source-dot.forum { background: #14b8a6; }

        .nav-count {
            margin-left: auto;
            background: var(--bg-elevated);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            color: var(--text-muted);
        }

        .sidebar-footer {
            margin-top: auto;
            padding-top: 20px;
            border-top: 1px solid var(--border);
        }

        /* Header */
        .page-header {
            margin-bottom: 32px;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
        }

        .page-title {
            font-size: 28px;
            font-weight: 700;
            letter-spacing: -0.75px;
            margin-bottom: 6px;
        }

        .page-desc { color: var(--text-secondary); font-size: 14px; }

        .header-actions { display: flex; gap: 12px; }

        /* Stats */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 28px;
        }

        .stat-card {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 24px;
            position: relative;
            overflow: hidden;
            transition: all 0.2s ease;
        }

        .stat-card:hover {
            border-color: var(--border-strong);
            transform: translateY(-2px);
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: var(--gradient);
            opacity: 0;
            transition: opacity 0.2s;
        }

        .stat-card:hover::before { opacity: 1; }

        .stat-icon {
            width: 40px;
            height: 40px;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 16px;
        }

        .stat-icon svg { width: 20px; height: 20px; }
        .stat-icon.total { background: var(--accent-soft); color: var(--accent); }
        .stat-icon.positive { background: var(--positive-soft); color: var(--positive); }
        .stat-icon.negative { background: var(--negative-soft); color: var(--negative); }
        .stat-icon.warning { background: var(--warning-soft); color: var(--warning); }

        .stat-label {
            font-size: 13px;
            color: var(--text-muted);
            margin-bottom: 8px;
            font-weight: 500;
        }

        .stat-value {
            font-size: 32px;
            font-weight: 700;
            letter-spacing: -1px;
            line-height: 1;
        }

        .stat-value.positive { color: var(--positive); }
        .stat-value.negative { color: var(--negative); }
        .stat-value.warning { color: var(--warning); }

        /* Cards */
        .card {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 16px;
            overflow: hidden;
        }

        .card-header {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .card-title {
            font-size: 14px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .card-title-icon {
            width: 28px;
            height: 28px;
            background: var(--accent-soft);
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .card-title-icon svg { width: 14px; height: 14px; color: var(--accent); }
        .card-body { padding: 24px; }

        /* Grid */
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 20px; }
        .grid-3 { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; margin-bottom: 20px; }

        /* Buttons */
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 10px 18px;
            border-radius: 10px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            border: none;
            font-family: inherit;
        }

        .btn-primary {
            background: var(--gradient);
            color: white;
            box-shadow: 0 4px 12px rgba(168,85,247,0.25);
        }

        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 6px 20px rgba(168,85,247,0.35);
        }

        .btn-secondary {
            background: var(--bg-elevated);
            color: var(--text);
            border: 1px solid var(--border);
        }

        .btn-secondary:hover { background: var(--bg-hover); }

        .btn-ghost {
            background: transparent;
            color: var(--text-secondary);
            padding: 8px 12px;
        }

        .btn-ghost:hover {
            background: var(--bg-elevated);
            color: var(--text);
        }

        .btn svg { width: 16px; height: 16px; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Badges */
        .badge {
            display: inline-flex;
            align-items: center;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 600;
            text-transform: capitalize;
        }

        .badge-positive { background: var(--positive-soft); color: var(--positive); }
        .badge-negative { background: var(--negative-soft); color: var(--negative); }
        .badge-neutral { background: var(--bg-elevated); color: var(--text-secondary); }
        .badge-critical { background: var(--negative); color: white; }
        .badge-high { background: var(--warning-soft); color: var(--warning); }
        .badge-medium { background: var(--bg-elevated); color: var(--text-secondary); }
        .badge-low { background: rgba(59,130,246,0.15); color: #60a5fa; }

        /* Source pills */
        .source-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 600;
            text-transform: capitalize;
        }

        .source-pill::before {
            content: '';
            width: 6px;
            height: 6px;
            border-radius: 50%;
        }

        .source-pill.discord { background: rgba(88,101,242,0.15); color: #5865F2; }
        .source-pill.discord::before { background: #5865F2; }
        .source-pill.github { background: rgba(255,255,255,0.1); color: #f0f0f0; }
        .source-pill.github::before { background: #f0f0f0; }
        .source-pill.support { background: var(--accent-soft); color: var(--accent); }
        .source-pill.support::before { background: var(--accent); }
        .source-pill.twitter { background: rgba(29,161,242,0.15); color: #1da1f2; }
        .source-pill.twitter::before { background: #1da1f2; }
        .source-pill.email { background: rgba(234,88,12,0.15); color: #ea580c; }
        .source-pill.email::before { background: #ea580c; }
        .source-pill.forum { background: rgba(20,184,166,0.15); color: #14b8a6; }
        .source-pill.forum::before { background: #14b8a6; }

        /* Theme tags */
        .theme-tag {
            display: inline-flex;
            padding: 3px 10px;
            background: var(--bg-elevated);
            border-radius: 4px;
            font-size: 11px;
            color: var(--text-secondary);
            font-weight: 500;
        }

        /* Filters */
        .filters {
            display: flex;
            gap: 12px;
            padding: 16px 24px;
            border-bottom: 1px solid var(--border);
            background: rgba(0,0,0,0.2);
        }

        .filter-select {
            appearance: none;
            background: var(--bg-elevated) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2371717a' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E") no-repeat right 12px center;
            padding: 8px 32px 8px 14px;
            border: 1px solid var(--border);
            border-radius: 8px;
            font-size: 13px;
            color: var(--text);
            cursor: pointer;
            font-family: inherit;
            transition: all 0.2s;
        }

        .filter-select:hover { border-color: var(--border-strong); }
        .filter-select:focus { outline: none; border-color: var(--accent); }
        .filter-select option { background: var(--bg-surface); }

        /* Feedback list */
        .feedback-list { max-height: 600px; overflow-y: auto; }

        .feedback-card {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border);
            transition: background 0.2s;
        }

        .feedback-card:hover { background: rgba(255,255,255,0.02); }
        .feedback-card:last-child { border-bottom: none; }

        .feedback-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 12px;
            flex-wrap: wrap;
        }

        .feedback-author {
            font-size: 13px;
            color: var(--text-muted);
        }

        .feedback-badges { display: flex; gap: 8px; margin-left: auto; }

        .feedback-content {
            color: var(--text);
            line-height: 1.7;
            margin-bottom: 14px;
            font-size: 14px;
        }

        .feedback-meta {
            display: flex;
            align-items: center;
            gap: 16px;
            flex-wrap: wrap;
        }

        .feedback-themes { display: flex; gap: 6px; flex-wrap: wrap; }

        .feedback-summary {
            font-size: 12px;
            color: var(--text-muted);
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .feedback-summary svg { width: 14px; height: 14px; color: var(--accent); }

        /* Progress bars for themes */
        .theme-item {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 16px;
        }

        .theme-item:last-child { margin-bottom: 0; }

        .theme-name {
            font-size: 13px;
            color: var(--text);
            width: 120px;
            flex-shrink: 0;
            font-weight: 500;
        }

        .theme-bar {
            flex: 1;
            height: 8px;
            background: var(--bg-elevated);
            border-radius: 4px;
            overflow: hidden;
        }

        .theme-fill {
            height: 100%;
            background: var(--gradient);
            border-radius: 4px;
            transition: width 0.5s ease;
        }

        .theme-count {
            font-size: 12px;
            color: var(--text-muted);
            width: 30px;
            text-align: right;
        }

        /* AI Summary */
        .ai-summary {
            background: linear-gradient(135deg, rgba(168,85,247,0.1) 0%, rgba(99,102,241,0.1) 100%);
            border: 1px solid rgba(168,85,247,0.2);
            border-radius: 12px;
            padding: 20px;
        }

        .ai-summary-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
        }

        .ai-icon {
            width: 36px;
            height: 36px;
            background: var(--gradient);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(168,85,247,0.3);
        }

        .ai-icon svg { width: 18px; height: 18px; color: white; }

        .ai-summary-title {
            font-weight: 600;
            font-size: 14px;
        }

        .ai-summary-subtitle {
            font-size: 12px;
            color: var(--text-muted);
        }

        .ai-summary-text {
            color: var(--text-secondary);
            font-size: 13px;
            line-height: 1.8;
        }

        .ai-summary-text p { margin-bottom: 12px; }
        .ai-summary-text p:last-child { margin-bottom: 0; }

        /* Empty state */
        .empty-state {
            text-align: center;
            padding: 80px 20px;
        }

        .empty-icon {
            width: 64px;
            height: 64px;
            margin: 0 auto 20px;
            background: var(--bg-elevated);
            border-radius: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .empty-icon svg { width: 28px; height: 28px; color: var(--text-muted); }
        .empty-state h3 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
        .empty-state p { color: var(--text-muted); font-size: 14px; }

        /* Toast */
        .toast {
            position: fixed;
            bottom: 24px;
            right: 24px;
            background: var(--bg-surface);
            border: 1px solid var(--border);
            color: var(--text);
            padding: 14px 20px;
            border-radius: 12px;
            font-size: 13px;
            font-weight: 500;
            transform: translateY(100px);
            opacity: 0;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 100;
            display: flex;
            align-items: center;
            gap: 10px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }

        .toast.show { transform: translateY(0); opacity: 1; }
        .toast svg { width: 18px; height: 18px; color: var(--positive); }

        /* Loading */
        .skeleton {
            background: linear-gradient(90deg, var(--bg-elevated) 25%, var(--bg-hover) 50%, var(--bg-elevated) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.5s infinite;
            border-radius: 6px;
        }

        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .animate-spin { animation: spin 1s linear infinite; }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--bg-hover); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }

        /* Responsive */
        @media (max-width: 1200px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .grid-2, .grid-3 { grid-template-columns: 1fr; }
        }

        @media (max-width: 768px) {
            .sidebar {
                transform: translateX(-100%);
                transition: transform 0.3s;
            }
            .sidebar.open { transform: translateX(0); }
            .main { margin-left: 0; padding: 20px; }
            .page-header { flex-direction: column; gap: 16px; }
            .header-actions { width: 100%; }
            .filters { flex-wrap: wrap; }
        }
    </style>
</head>
<body>
    <div class="app">
        <!-- Sidebar -->
        <aside class="sidebar">
            <div class="logo">
                <div class="logo-icon">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                </div>
                <span class="logo-text">Pulse</span>
            </div>

            <nav class="nav-section">
                <div class="nav-label">Filter by Source</div>
                <div class="nav-item" id="nav-all" onclick="filterBySource('')">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 6h16M4 12h16M4 18h16"></path></svg>
                    All Sources
                    <span class="nav-count" id="nav-total">0</span>
                </div>
                <div class="nav-item" id="nav-discord" onclick="filterBySource('discord')">
                    <span class="source-dot discord"></span> Discord
                    <span class="nav-count" id="count-discord">-</span>
                </div>
                <div class="nav-item" id="nav-github" onclick="filterBySource('github')">
                    <span class="source-dot github"></span> GitHub
                    <span class="nav-count" id="count-github">-</span>
                </div>
                <div class="nav-item" id="nav-support" onclick="filterBySource('support')">
                    <span class="source-dot support"></span> Support
                    <span class="nav-count" id="count-support">-</span>
                </div>
                <div class="nav-item" id="nav-twitter" onclick="filterBySource('twitter')">
                    <span class="source-dot twitter"></span> Twitter
                    <span class="nav-count" id="count-twitter">-</span>
                </div>
                <div class="nav-item" id="nav-email" onclick="filterBySource('email')">
                    <span class="source-dot email"></span> Email
                    <span class="nav-count" id="count-email">-</span>
                </div>
                <div class="nav-item" id="nav-forum" onclick="filterBySource('forum')">
                    <span class="source-dot forum"></span> Forum
                    <span class="nav-count" id="count-forum">-</span>
                </div>
            </nav>

            <div class="sidebar-footer" style="font-size:11px;color:var(--text-muted);text-align:center;">
                Powered by Cloudflare Workers AI
            </div>
        </aside>

        <!-- Main Content -->
        <main class="main">
            <header class="page-header">
                <div>
                    <h1 class="page-title">Feedback Intelligence</h1>
                    <p class="page-desc">AI-powered analysis across all customer channels</p>
                </div>
                <div class="header-actions">
                    <button onclick="refreshAll()" class="btn btn-secondary">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                        Refresh All
                    </button>
                </div>
            </header>

            <!-- Stats -->
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon total">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
                    </div>
                    <div class="stat-label">Total Feedback</div>
                    <div class="stat-value" id="stat-total">0</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon positive">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <div class="stat-label">Positive Sentiment</div>
                    <div class="stat-value positive" id="stat-positive">0</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon negative">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <div class="stat-label">Negative Sentiment</div>
                    <div class="stat-value negative" id="stat-negative">0</div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon warning">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                    </div>
                    <div class="stat-label">Requires Attention</div>
                    <div class="stat-value warning" id="stat-urgent">0</div>
                </div>
            </div>

            <!-- Charts + Themes Row -->
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:20px;">
                <div class="card">
                    <div class="card-header">
                        <span class="card-title">
                            <span class="card-title-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"></path></svg></span>
                            By Source
                        </span>
                    </div>
                    <div class="card-body">
                        <div style="height:200px;"><canvas id="sourceChart"></canvas></div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header">
                        <span class="card-title">
                            <span class="card-title-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg></span>
                            Sentiment
                        </span>
                    </div>
                    <div class="card-body">
                        <div style="height:200px;"><canvas id="sentimentChart"></canvas></div>
                    </div>
                </div>
                <div class="card">
                    <div class="card-header">
                        <span class="card-title">
                            <span class="card-title-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path></svg></span>
                            Trending Topics
                        </span>
                    </div>
                    <div class="card-body" id="themes-list">
                        <div class="skeleton" style="height:16px;width:100%;margin-bottom:14px;"></div>
                        <div class="skeleton" style="height:16px;width:85%;margin-bottom:14px;"></div>
                        <div class="skeleton" style="height:16px;width:70%;margin-bottom:14px;"></div>
                        <div class="skeleton" style="height:16px;width:55%;"></div>
                    </div>
                </div>
            </div>

            <!-- AI Executive Summary -->
            <div class="card" style="margin-bottom:20px;border:1px solid rgba(168,85,247,0.3);background:linear-gradient(135deg, rgba(168,85,247,0.05) 0%, rgba(99,102,241,0.05) 100%);">
                <div class="card-header" style="border-bottom:1px solid rgba(168,85,247,0.2);">
                    <span class="card-title">
                        <span class="card-title-icon" style="background:var(--gradient);"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:white;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg></span>
                        AI Executive Summary
                    </span>
                    <span style="font-size:12px;color:var(--text-muted);">Powered by Cloudflare Workers AI (Llama 3.1 8B)</span>
                </div>
                <div class="card-body" id="ai-summary">
                    <div style="display:flex;align-items:center;gap:12px;color:var(--text-muted);">
                        <svg class="animate-spin" fill="none" viewBox="0 0 24 24" style="width:20px;height:20px;flex-shrink:0;"><circle style="opacity:0.25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path style="opacity:0.75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                        <span>Analyzing feedback with AI...</span>
                    </div>
                </div>
            </div>

            <!-- Feedback List -->
            <div class="card">
                <div class="card-header">
                    <span class="card-title">
                        <span class="card-title-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg></span>
                        All Feedback
                    </span>
                </div>
                <div class="filters">
                    <select id="filter-source" onchange="loadFeedback()" class="filter-select">
                        <option value="">All Sources</option>
                        <option value="discord">Discord</option>
                        <option value="github">GitHub</option>
                        <option value="support">Support</option>
                        <option value="twitter">Twitter</option>
                        <option value="email">Email</option>
                        <option value="forum">Forum</option>
                    </select>
                    <select id="filter-sentiment" onchange="loadFeedback()" class="filter-select">
                        <option value="">All Sentiment</option>
                        <option value="positive">Positive</option>
                        <option value="neutral">Neutral</option>
                        <option value="negative">Negative</option>
                    </select>
                    <select id="filter-urgency" onchange="loadFeedback()" class="filter-select">
                        <option value="">All Priority</option>
                        <option value="critical">Critical</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                    </select>
                </div>
                <div class="feedback-list" id="feedback-list">
                    <div class="empty-state">
                        <div class="empty-icon">
                            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path></svg>
                        </div>
                        <h3>No feedback yet</h3>
                        <p>Feedback from Discord, GitHub, Support, Twitter, and other channels will appear here.</p>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <!-- Toast -->
    <div id="toast" class="toast">
        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
        <span id="toast-message"></span>
    </div>

    <script>
        let sourceChart, sentimentChart;
        let currentSource = '';

        function showToast(message, type = 'success') {
            const toast = document.getElementById('toast');
            const msg = document.getElementById('toast-message');
            msg.textContent = message;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3000);
        }

        async function refreshData() {
            await Promise.all([loadStats(), loadFeedback()]);
        }

        async function refreshAll() {
            await Promise.all([loadStats(), loadFeedback(), generateSummary()]);
            showToast('Dashboard refreshed');
        }

        function filterBySource(source) {
            currentSource = source;
            document.getElementById('filter-source').value = source;

            // Update sidebar active state
            document.querySelectorAll('.nav-section .nav-item').forEach(item => {
                item.classList.remove('active');
            });
            const activeNav = document.getElementById('nav-' + (source || 'all'));
            if (activeNav) activeNav.classList.add('active');

            loadFeedback();
        }

        async function loadStats() {
            try {
                const res = await fetch('/api/stats');
                const stats = await res.json();

                document.getElementById('stat-total').textContent = stats.total || 0;
                document.getElementById('stat-positive').textContent = stats.sentiment?.positive || 0;
                document.getElementById('stat-negative').textContent = stats.sentiment?.negative || 0;
                document.getElementById('stat-urgent').textContent = (stats.urgency?.critical || 0) + (stats.urgency?.high || 0);
                document.getElementById('nav-total').textContent = stats.total || 0;

                // Update source counts
                const sources = stats.sources || {};
                ['discord', 'github', 'support', 'twitter', 'email', 'forum'].forEach(s => {
                    const el = document.getElementById('count-' + s);
                    if (el) el.textContent = sources[s] || 0;
                });

                // Update themes
                const themesList = document.getElementById('themes-list');
                if (stats.topThemes && stats.topThemes.length > 0) {
                    const maxCount = Math.max(...stats.topThemes.map(t => t.count));
                    themesList.innerHTML = stats.topThemes.slice(0, 6).map(t => {
                        const pct = (t.count / maxCount * 100).toFixed(0);
                        return '<div class="theme-item"><span class="theme-name">' + t.name + '</span><div class="theme-bar"><div class="theme-fill" style="width:' + pct + '%"></div></div><span class="theme-count">' + t.count + '</span></div>';
                    }).join('');
                } else {
                    themesList.innerHTML = '<div style="text-align:center;padding:30px 10px;color:var(--text-muted);font-size:13px;">No themes detected yet.</div>';
                }

                updateCharts(stats);
            } catch (e) {
                console.error('Error loading stats:', e);
            }
        }

        function updateCharts(stats) {
            const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 20,
                            usePointStyle: true,
                            pointStyle: 'circle',
                            font: { size: 11, family: 'Inter' },
                            color: '#a1a1aa'
                        }
                    }
                },
                cutout: '70%'
            };

            // Source chart
            const sourceCtx = document.getElementById('sourceChart').getContext('2d');
            if (sourceChart) sourceChart.destroy();

            const sourceData = stats.sources || {};
            sourceChart = new Chart(sourceCtx, {
                type: 'doughnut',
                data: {
                    labels: Object.keys(sourceData).map(s => s.charAt(0).toUpperCase() + s.slice(1)),
                    datasets: [{
                        data: Object.values(sourceData),
                        backgroundColor: ['#5865F2', '#71717a', '#a855f7', '#1da1f2', '#ea580c', '#14b8a6'],
                        borderWidth: 0,
                        spacing: 2
                    }]
                },
                options: chartOptions
            });

            // Sentiment chart
            const sentimentCtx = document.getElementById('sentimentChart').getContext('2d');
            if (sentimentChart) sentimentChart.destroy();
            sentimentChart = new Chart(sentimentCtx, {
                type: 'doughnut',
                data: {
                    labels: ['Positive', 'Neutral', 'Negative'],
                    datasets: [{
                        data: [stats.sentiment?.positive || 0, stats.sentiment?.neutral || 0, stats.sentiment?.negative || 0],
                        backgroundColor: ['#22c55e', '#71717a', '#ef4444'],
                        borderWidth: 0,
                        spacing: 2
                    }]
                },
                options: chartOptions
            });
        }

        async function loadFeedback() {
            const source = document.getElementById('filter-source').value;
            const sentiment = document.getElementById('filter-sentiment').value;
            const urgency = document.getElementById('filter-urgency').value;

            const params = new URLSearchParams();
            if (source) params.set('source', source);
            if (sentiment) params.set('sentiment', sentiment);
            if (urgency) params.set('urgency', urgency);

            try {
                const res = await fetch('/api/feedback?' + params.toString());
                const data = await res.json();

                const list = document.getElementById('feedback-list');
                if (data.feedback && data.feedback.length > 0) {
                    list.innerHTML = data.feedback.map(f =>
                        '<div class="feedback-card">' +
                        '<div class="feedback-header">' +
                        '<span class="source-pill ' + f.source + '">' + f.source + '</span>' +
                        '<span class="feedback-author">@' + (f.author || 'anonymous') + '</span>' +
                        '<div class="feedback-badges">' +
                        '<span class="badge badge-' + f.sentiment + '">' + f.sentiment + '</span>' +
                        '<span class="badge badge-' + f.urgency + '">' + f.urgency + '</span>' +
                        '</div>' +
                        '</div>' +
                        '<p class="feedback-content">' + f.content + '</p>' +
                        '<div class="feedback-meta">' +
                        '<div class="feedback-themes">' +
                        (f.themes || []).map(t => '<span class="theme-tag">' + t + '</span>').join('') +
                        '</div>' +
                        '<span class="feedback-summary"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>' + (f.summary || 'No summary') + '</span>' +
                        '</div>' +
                        '</div>'
                    ).join('');
                } else {
                    list.innerHTML = '<div class="empty-state"><div class="empty-icon"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path></svg></div><h3>No feedback found</h3><p>Try adjusting your filters or check back later.</p></div>';
                }
            } catch (e) {
                console.error('Error loading feedback:', e);
            }
        }

        async function generateSummary() {
            const summaryDiv = document.getElementById('ai-summary');

            // Show loading state
            summaryDiv.innerHTML = '<div style="display:flex;align-items:center;gap:12px;color:var(--text-muted);"><svg class="animate-spin" fill="none" viewBox="0 0 24 24" style="width:20px;height:20px;flex-shrink:0;"><circle style="opacity:0.25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path style="opacity:0.75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg><span>Analyzing feedback with AI...</span></div>';

            try {
                const res = await fetch('/api/summary');
                const data = await res.json();

                if (data.summary && data.summary !== 'No feedback available yet.') {
                    const formattedSummary = data.summary.split('\\n').filter(p => p.trim()).map(p => '<p style="margin-bottom:12px;line-height:1.8;">' + p + '</p>').join('');
                    summaryDiv.innerHTML = '<div style="color:var(--text-secondary);font-size:14px;">' + formattedSummary + '</div><div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--text-muted);">Based on ' + (data.feedbackCount || 0) + ' feedback items</div>';
                } else {
                    summaryDiv.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">No feedback data available. Add some feedback to see AI-generated insights.</div>';
                }
            } catch (e) {
                summaryDiv.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;">Unable to generate summary. Click "Refresh All" to try again.</div>';
            }
        }

        // Initial load - auto-generate summary
        async function init() {
            // Set "All Sources" as active by default
            document.getElementById('nav-all').classList.add('active');

            // Load everything in parallel
            await Promise.all([loadStats(), loadFeedback(), generateSummary()]);
        }

        init();
    </script>
</body>
</html>`;

// Serve dashboard at root
app.get('/', (c) => {
	return c.html(dashboardHtml);
});

export default app;
