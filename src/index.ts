/*
 * File: index.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import { networkInterfaces } from "node:os";
import { serve } from "@hono/node-server";
import * as dotenv from "dotenv";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { chatCompletions } from "./routes/chat.ts";
import {
	activePage,
	type BrowserType,
	initPlaywright,
} from "./services/playwright.ts";
import { fetchQwenModels } from "./services/qwen.ts";

dotenv.config();

export const app = new Hono();

app.use("*", cors());

// Helper to get local network IPs
function getNetworkAddress() {
	const interfaces = networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		const ifaceList = interfaces[name];
		if (!ifaceList) continue;
		for (const iface of ifaceList) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address;
			}
		}
	}
	return null;
}

// API Key protection middleware
app.use("/v1/*", async (c, next) => {
	const apiKey = process.env.API_KEY;
	if (!apiKey) {
		return await next();
	}
	return bearerAuth({ token: apiKey })(c, next);
});

// Basic health check
app.get("/health", (c) => c.json({ status: "ok" }));

// OpenAI compatible routes
app.post("/v1/chat/completions", chatCompletions);

app.get("/v1/models", async (c) => {
	try {
		const models = await fetchQwenModels();
		return c.json({
			object: "list",
			data: models,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: { message } }, 500);
	}
});

// Initialize playwright when server starts
import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	// Parse browser type from args or env
	let browserType: BrowserType = "chromium";
	const browserArg = process.argv.find((arg) => arg.startsWith("--browser="));
	if (browserArg) {
		browserType = browserArg.split("=")[1] as BrowserType;
	} else if (process.env.BROWSER) {
		browserType = process.env.BROWSER as BrowserType;
	}

	initPlaywright(true, browserType)
		.then(async () => {
			console.log(`Playwright initialized (${browserType}).`);

			const email = process.env.QWEN_EMAIL;
			const password = process.env.QWEN_PASSWORD;
			if (email && password) {
				const { loginToQwenViaApi, loginToQwen } = await import(
					"./services/playwright.ts"
				);
				let success = await loginToQwenViaApi(email, password);
				if (!success) {
					console.log("[Init] API failed, trying UI...");
					success = await loginToQwen(email, password);
				}
				if (!success) {
					console.log("[Init] Login failed, exiting...");
					process.exit(1);
				}
			} else if (activePage) {
				await activePage.goto("https://chat.qwen.ai/auth", {
					waitUntil: "domcontentloaded",
					timeout: 60000,
				});
			}

			const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

			const networkIP = getNetworkAddress();

			console.log("\n🚀 QwenProxy started!");
			console.log(`- Local:   http://localhost:${port}`);
			if (networkIP) {
				console.log(`- Network: http://${networkIP}:${port}`);
			}

			console.log("\nAvailable Routes:");
			app.routes.forEach((route) => {
				console.log(`- [${route.method}] ${route.path}`);
			});
			console.log("");

			serve({
				fetch: app.fetch,
				port,
			});
		})
		.catch((err) => {
			console.error("Failed to initialize playwright:", err);
			process.exit(1);
		});
}
