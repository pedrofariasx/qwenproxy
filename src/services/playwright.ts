/*
 * File: playwright.ts
 * Project: qwenproxy
 * Author: Pedro Farias
 * Created: 2026-05-09
 *
 * Last Modified: Sat May 09 2026
 * Modified By: Pedro Farias
 */

import crypto from "node:crypto";
import path from "node:path";
import {
	type BrowserContext,
	chromium,
	firefox,
	type Page,
	webkit,
} from "playwright";

export type BrowserType = "chromium" | "firefox" | "webkit" | "chrome" | "edge";

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
let currentHeaders: Record<string, string> = {};
let cachedQwenHeaders: {
	headers: Record<string, string>;
	chatSessionId: string;
	parentMessageId: string | null;
} | null = null;
let lastHeadersTime = 0;
const HEADERS_TTL = 10 * 60 * 1000; // 10 minutes

let uiLock: Promise<void> = Promise.resolve();

const INPUT_SELECTOR = 'textarea:visible, [contenteditable="true"]:visible';
const SEND_SELECTORS = [
	".message-input-right-button-send .send-button",
	".chat-prompt-send-button",
	"button.send-button",
];

export async function getCookies(): Promise<string> {
	if (process.env.TEST_MOCK_PLAYWRIGHT) return "token=mock";
	if (!activePage) return "";
	const cookies = await activePage.context().cookies();
	return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function hasAuthTokenCookie(): Promise<boolean> {
	if (process.env.TEST_MOCK_PLAYWRIGHT) return true;
	if (!activePage) return false;
	const cookies = await activePage.context().cookies("https://chat.qwen.ai/");
	return cookies.some((c) => c.name === "token" && c.value);
}

export async function getBasicHeaders(): Promise<{
	cookie: string;
	userAgent: string;
	bxV: string;
}> {
	if (process.env.TEST_MOCK_PLAYWRIGHT)
		return { cookie: "token=mock", userAgent: "mock", bxV: "2.5.36" };
	if (!activePage) throw new Error("Playwright not initialized");

	const cookie = await getCookies();
	const userAgent = await activePage.evaluate(() => navigator.userAgent);
	const bxV = currentHeaders["bx-v"] || "2.5.36";

	return { cookie, userAgent, bxV };
}

export async function initPlaywright(
	headless = true,
	browserType: BrowserType = "chromium",
) {
	if (process.env.TEST_MOCK_PLAYWRIGHT) return;
	if (context) {
		return;
	}

	const profilePath = path.resolve("qwen_profile");

	let browserEngine: typeof chromium | typeof firefox | typeof webkit;
	let channel: string | undefined;

	switch (browserType) {
		case "firefox":
			browserEngine = firefox;
			break;
		case "webkit":
			browserEngine = webkit;
			break;
		case "chrome":
			browserEngine = chromium;
			channel = "chrome";
			break;
		case "edge":
			browserEngine = chromium;
			channel = "msedge";
			break;
		default:
			browserEngine = chromium;
			break;
	}

	console.log(`[Playwright] Launching ${browserType}...`);

	context = await browserEngine.launchPersistentContext(profilePath, {
		headless,
		channel,
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
		args: [
			"--disable-blink-features=AutomationControlled",
			"--no-sandbox",
			"--disable-setuid-sandbox",
			"--disable-dev-shm-usage",
			"--disable-gpu",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--no-zygote",
		],
	});

	await context.addInitScript(() => {
		Object.defineProperty(navigator, "webdriver", { get: () => false });
	});

	activePage = await context.newPage();
}

export async function closePlaywright() {
	if (process.env.TEST_MOCK_PLAYWRIGHT) return;
	if (context) {
		await context.close();
		context = null;
		activePage = null;
	}
}

export async function loginToQwen(
	email: string,
	password: string,
): Promise<boolean> {
	if (!activePage) throw new Error("Playwright not initialized");

	await activePage.goto("https://chat.qwen.ai/auth", {
		waitUntil: "domcontentloaded",
		timeout: 60000,
	});
	await activePage.waitForTimeout(2000);

	if (!activePage.url().includes("/auth")) {
		console.log("[UI] Already logged in");
		return true;
	}

	try {
		await activePage.waitForSelector(
			'input[type="email"], input[placeholder*="Email"]',
			{ timeout: 5000 },
		);
	} catch (e) {
		if (activePage.url().includes("/auth")) {
			throw e;
		}
		console.log("[UI] Already logged in");
		return true;
	}

	console.log("[UI] Filling credentials...");
	await activePage.fill(
		'input[type="email"], input[placeholder*="Email"]',
		email,
	);
	await activePage.keyboard.press("Enter");
	await activePage.waitForTimeout(1000);

	await activePage.waitForSelector('input[type="password"]', {
		timeout: 10000,
	});
	await activePage.fill('input[type="password"]', password);
	await activePage.keyboard.press("Enter");

	await activePage.waitForTimeout(2000);

	const errorSelector =
		'[class*="error"], [class*="Error"], [role="alert"], .ant-form-item-explain-error';
	const errorElement = await activePage.$(errorSelector);
	if (errorElement) {
		const errorText = await errorElement.textContent();
		console.log("[UI] Error:", errorText?.trim());
		return false;
	}

	await activePage.waitForSelector(INPUT_SELECTOR, { timeout: 30000 });
	console.log("[UI] Login OK");
	return true;
}

export async function loginToQwenViaApi(
	email: string,
	password: string,
): Promise<boolean> {
	if (!activePage) throw new Error("Playwright not initialized");

	await activePage.goto("https://chat.qwen.ai/auth", {
		waitUntil: "domcontentloaded",
		timeout: 60000,
	});

	if (!activePage.url().includes("/auth")) {
		console.log("[Playwright API] Already logged in.");
		return true;
	}

	const hashedPassword = crypto
		.createHash("sha256")
		.update(password)
		.digest("hex");
	const timezone = new Date().toString().split(" (")[0];

	const result = await activePage.evaluate(
		async ({ email, password, timezone }) => {
			try {
				const response = await fetch(
					"https://chat.qwen.ai/api/v2/auths/signin",
					{
						method: "POST",
						headers: {
							accept: "application/json, text/plain, */*",
							"content-type": "application/json",
							source: "web",
							timezone: timezone,
							"x-request-id": crypto.randomUUID(),
						},
						body: JSON.stringify({ email, password, login_type: "email" }),
					},
				);
				const data = await response.json();
				return { ok: response.ok, status: response.status, data };
			} catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
		{ email, password: hashedPassword, timezone },
	);

	if (result.ok && result.data?.success) {
		await activePage.goto("https://chat.qwen.ai/", {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
		await activePage.waitForTimeout(2000);

		if (
			!activePage.url().includes("auth") &&
			!activePage.url().includes("login")
		) {
			console.log("[API] Login OK");
			return true;
		}
	}

	const msg =
		result.data?.data?.details ||
		result.data?.message ||
		result.error ||
		"Login failed";
	console.log("[API] Login failed:", msg);
	return false;
}

/**
 * Ensures the session is valid and extracts headers, PoW, and session ID.
 */
export async function getQwenHeaders(forceNew = false): Promise<{
	headers: Record<string, string>;
	chatSessionId: string;
	parentMessageId: string | null;
}> {
	// Use a lock to ensure only one request uses the UI at a time
	const release = await new Promise<() => void>((resolve) => {
		uiLock = uiLock.then(
			() =>
				new Promise<void>((innerResolve) => {
					resolve(innerResolve);
				}),
		);
	});

	try {
		return await _getQwenHeadersInternal(forceNew);
	} finally {
		release();
	}
}

async function _getQwenHeadersInternal(forceNew = false): Promise<{
	headers: Record<string, string>;
	chatSessionId: string;
	parentMessageId: string | null;
}> {
	if (process.env.TEST_MOCK_PLAYWRIGHT) {
		const mockSessionId = process.env.TEST_SESSION_ID || "mock-session";
		return {
			headers: {
				authorization: "Bearer MOCK",
				cookie: "token=mock",
				"user-agent": "mock",
				"bx-v": "2.5.36",
			},
			chatSessionId: mockSessionId,
			parentMessageId: null,
		};
	}

	if (
		!forceNew &&
		cachedQwenHeaders &&
		Date.now() - lastHeadersTime < HEADERS_TTL
	) {
		return cachedQwenHeaders;
	}

	if (!activePage) {
		throw new Error("Playwright not initialized");
	}

	// Clear cache and retry if needed
	let retries = 2;
	while (retries >= 0) {
		try {
			return await _fetchQwenHeaders(forceNew);
		} catch (err) {
			if (
				err instanceof Error &&
				err.message === "RETRY_HEADER_FETCH" &&
				retries > 0
			) {
				console.log("[Playwright] Retrying header fetch...");
				retries--;
				cachedQwenHeaders = null;
				lastHeadersTime = 0;
				continue;
			}
			throw err;
		}
	}
	throw new Error("Failed to fetch Qwen headers after retries");
}

async function _fetchQwenHeaders(forceNew = false): Promise<{
	headers: Record<string, string>;
	chatSessionId: string;
	parentMessageId: string | null;
}> {
	if (!activePage) throw new Error("Playwright not initialized");

	const currentUrl = activePage.url();
	const isOnQwen = currentUrl.includes("chat.qwen.ai");
	const isOnSpecificChat = isOnQwen && /\/c\//.test(currentUrl);

	if (!isOnQwen || forceNew || isOnSpecificChat) {
		await activePage.goto("https://chat.qwen.ai/", {
			waitUntil: "domcontentloaded",
			timeout: 60000,
		});
	}

	// Check if we are logged in. Qwen can show a usable /c/guest chat page with
	// no login page, but guest sessions hit a much lower usage limit. Treat a
	// missing token cookie as unauthenticated and use the configured credentials.
	const isLoginPage =
		activePage.url().includes("login") ||
		activePage.url().includes("auth") ||
		(await activePage.$('input[type="email"], input[placeholder*="Email"]'));
	const hasAuthToken = await hasAuthTokenCookie();
	if (isLoginPage || !hasAuthToken) {
		const email = process.env.QWEN_EMAIL;
		const password = process.env.QWEN_PASSWORD;

		if (email && password) {
			console.log(
				`[Playwright] ${isLoginPage ? "Detected login page" : "Missing Qwen auth token; guest session detected"}. Attempting automated login...`,
			);
			const apiSuccess = await loginToQwenViaApi(email, password);
			if (apiSuccess) {
				console.log("[Playwright] API login successful.");
			} else {
				console.log("[Playwright] API login failed, trying UI fallback...");
				try {
					const loggedIn = await loginToQwen(email, password);
					if (!loggedIn) {
						throw new Error("loginToQwen returned false");
					}
					console.log("[Playwright] UI login successful.");
				} catch (err) {
					console.error(
						"[Playwright] Automated login failed:",
						err instanceof Error ? err.message : String(err),
					);
				}
			}
		} else {
			console.warn(
				"[Playwright] Qwen session appears unauthenticated but QWEN_EMAIL/PASSWORD not provided in .env",
			);
		}
	}

	await activePage
		.waitForSelector(INPUT_SELECTOR, { timeout: 30000 })
		.catch(() => {
			throw new Error("Timeout waiting for chat input. Are you logged in?");
		});

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			console.error(
				"[Playwright] Timeout waiting for Qwen headers. Current URL:",
				activePage?.url(),
			);
			reject(new Error("Timeout waiting for Qwen headers"));
		}, 60000);

		const routeHandler = async (
			route: {
				abort: (reason: string) => Promise<void>;
				unroute: (pattern: string, handler: unknown) => Promise<void>;
			},
			request: {
				headers: () => Record<string, string>;
				postData: () => string | null;
			},
		) => {
			clearTimeout(timeout);

			const reqHeaders = request.headers();
			let uiSessionId = "";
			let uiParentMessageId: string | null = null;

			const postData = request.postData();
			if (postData) {
				try {
					const payload = JSON.parse(postData);
					if (payload.chat_id) uiSessionId = payload.chat_id;
					if (payload.parent_id !== undefined)
						uiParentMessageId = payload.parent_id;
				} catch (_e) {}
			}

			const extractedHeaders = {
				cookie: reqHeaders.cookie || "",
				"bx-ua": reqHeaders["bx-ua"] || "",
				"bx-umidtoken": reqHeaders["bx-umidtoken"] || "",
				"bx-v": reqHeaders["bx-v"] || "",
				"x-request-id": reqHeaders["x-request-id"] || "",
				"user-agent": reqHeaders["user-agent"] || "",
			};

			if (!extractedHeaders.cookie || !extractedHeaders["bx-ua"]) {
				console.log("[Playwright] Missing critical headers, retrying...");
				cachedQwenHeaders = null;
				lastHeadersTime = 0;
				await route.abort("aborted");
				reject(new Error("RETRY_HEADER_FETCH"));
				return;
			}

			console.log("[Playwright] Headers intercepted.");
			currentHeaders = extractedHeaders;
			cachedQwenHeaders = {
				headers: extractedHeaders,
				chatSessionId: uiSessionId,
				parentMessageId: uiParentMessageId,
			};
			lastHeadersTime = Date.now();

			import("./qwen.ts").then((m) => m.disableNativeTools().catch(() => {}));

			await route.abort("aborted");
			await activePage?.unroute("**/api/v2/chat/completions*", routeHandler);
			resolve(cachedQwenHeaders);
		};

		activePage
			?.route("**/api/v2/chat/completions*", routeHandler)
			.then(async () => {
				await activePage?.focus(INPUT_SELECTOR);
				await activePage?.fill(INPUT_SELECTOR, "");
				await activePage?.type(INPUT_SELECTOR, "a", { delay: 100 });
				await activePage?.waitForTimeout(2000);

				for (const selector of SEND_SELECTORS) {
					const btn = await activePage?.$(selector);
					if (btn && (await btn.isVisible())) {
						await btn.click({ force: true }).catch(() => {});
						return;
					}
				}
				await activePage?.keyboard.press("Enter");
			});
	});
}
