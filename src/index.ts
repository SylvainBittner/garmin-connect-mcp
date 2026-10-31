import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

interface GarminEnv {
	GARMIN_API_KEY: string;
}

const GARMIN_BASE = "https://personal.connectapi.garmin.com";

const TOKEN_URL =
	`${GARMIN_BASE}/personalapitoken-service/personal-api/personal-api-key/token`;

function getEnv(): GarminEnv {
	return env as unknown as GarminEnv;
}

// ============================================================
// GARMIN AUTHENTICATION
// ============================================================

async function getGarminAccessToken(apiKey: string): Promise<string> {
	if (!apiKey || !apiKey.trim()) {
		throw new Error("GARMIN_API_KEY is missing.");
	}

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `ApiKey ${apiKey.trim()}`,
			Accept: "text/plain",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Garmin authentication failed: ${response.status} ${response.statusText}`,
		);
	}

	const token = (await response.text()).trim();

	if (!token) {
		throw new Error("Garmin returned no access token.");
	}

	return token;
}

// ============================================================
// GARMIN GET
// ============================================================

async function garminGet(
	path: string,
	params?: Record<string, string | number | boolean | undefined>,
): Promise<any> {
	const garminEnv = getEnv();

	const token = await getGarminAccessToken(
		garminEnv.GARMIN_API_KEY,
	);

	const url = new URL(`${GARMIN_BASE}${path}`);

	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) {
				url.searchParams.set(key, String(value));
			}
		}
	}

	const response = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});

	const text = await response.text();

	if (!response.ok) {
		throw new Error(
			`Garmin API failed: ${response.status} ${response.statusText} - ${text.slice(0, 500)}`,
		);
	}

	if (!text) {
		return null;
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

// ============================================================
// MCP RESULTS
// ============================================================

function textResult(data: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

function errorResult(error: unknown) {
	const message =
		error instanceof Error
			? error.message
			: String(error);

	return {
		content: [
			{
				type: "text" as const,
				text: `Garmin error: ${message}`,
			},
		],
		isError: true,
	};
}

function unwrap(
	result: PromiseSettledResult<any>,
) {
	if (result.status === "fulfilled") {
		return result.value;
	}

	return {
		unavailable: true,
		error:
			result.reason instanceof Error
				? result.reason.message
				: String(result.reason),
	};
}

// ============================================================
// MCP SERVER
// ============================================================

function createServer() {
	const server = new McpServer({
		name: "Garmin Connect SBL",
		version: "3.0.0",
	});

	// ========================================================
	// 1. CONNECTION
	// ========================================================

	server.registerTool(
		"garmin_connection_status",
		{
			description:
				"Tests the secure connection to Garmin Connect Personal API.",
		},
		async () => {
			try {
				const garminEnv = getEnv();

				await getGarminAccessToken(
					garminEnv.GARMIN_API_KEY,
				);

				return textResult({
					status: "connected",
					version: "3.0.0",
					message:
						"Garmin Connect authentication successful.",
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 2. SIMPLE MCP DISCOVERY TEST
	// ========================================================

	server.registerTool(
		"garmin_test_simple",
		{
			description:
				"Simple MCP tool discovery test.",
		},
		async () => {
			return textResult({
				status: "ok",
				version: "3.0.0",
				message:
					"Multiple MCP tools are being discovered correctly.",
			});
		},
	);

	// ========================================================
	// 3. ACTIVITIES
	// ========================================================

	server.registerTool(
		"garmin_activities",
		{
			description:
				"Search Garmin activities such as running, cycling, hiking and other workouts.",
			inputSchema: {
				start: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe(
						"Pagination starting position. Defaults to 0.",
					),

				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe(
						"Maximum number of activities to return. Defaults to 20.",
					),

				startDate: z
					.string()
					.optional()
					.describe(
						"Start date in YYYY-MM-DD format.",
					),

				endDate: z
					.string()
					.optional()
					.describe(
						"End date in YYYY-MM-DD format.",
					),

				activityType: z
					.string()
					.optional()
					.describe(
						"Optional Garmin activity type such as running or cycling.",
					),
			},
		},
		async ({
			start,
			limit,
			startDate,
			endDate,
			activityType,
		}) => {
			try {
				const data = await garminGet(
					"/activitylist-service/activities/search/activities",
					{
						start: start ?? 0,
						limit: limit ?? 20,
						startDate,
						endDate,
						activityType,
					},
				);

				return textResult(data);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 4. ACTIVITY DETAILS
	// ========================================================

	server.registerTool(
		"garmin_activity_details",
		{
			description:
				"Gets detailed Garmin information for one activity.",
			inputSchema: {
				activityId: z
					.number()
					.int()
					.positive()
					.describe(
						"Garmin activity ID.",
					),
			},
		},
		async ({ activityId }) => {
			try {
				const data = await garminGet(
					`/activity-service/activity/${activityId}`,
				);

				return textResult(data);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 5. ACTIVITY WORKOUT
	// ========================================================

	server.registerTool(
		"garmin_activity_workouts",
		{
			description:
				"Gets workout information associated with a Garmin activity.",
			inputSchema: {
				activityId: z
					.number()
					.int()
					.positive()
					.describe(
						"Garmin activity ID.",
					),
			},
		},
		async ({ activityId }) => {
			try {
				const data = await garminGet(
					`/activity-service/activity/${activityId}/workouts`,
				);

				return textResult(data);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 6. DAILY HEALTH
	// ========================================================

	server.registerTool(
		"garmin_daily_health",
		{
			description:
				"Gets Garmin health and recovery information for one day including HRV, sleep, heart rate, daily summary, Fitness Age and SpO2.",
			inputSchema: {
				date: z
					.string()
					.describe(
						"Date in YYYY-MM-DD format.",
					),
			},
		},
		async ({ date }) => {
			try {
				const [
					summary,
					heartRate,
					hrv,
					sleep,
					fitnessAge,
					spo2,
				] = await Promise.allSettled([
					garminGet(
						"/usersummary-service/v2/dailysummaries",
						{
							startDate: date,
							endDate: date,
						},
					),

					garminGet(
						"/wellness-service/wellness/dailyHeartRate",
						{
							date,
						},
					),

					garminGet(
						`/hrv-service/hrv/${date}`,
					),

					garminGet(
						"/sleep-service/sleep/dailySleep",
						{
							date,
						},
					),

					garminGet(
						`/fitnessage-service/fitnessage/v2/${date}`,
					),

					garminGet(
						`/wellness-service/wellness/daily/spo2acclimation/${date}`,
					),
				]);

				return textResult({
					date,

					dailySummary:
						unwrap(summary),

					heartRate:
						unwrap(heartRate),

					hrv:
						unwrap(hrv),

					sleep:
						unwrap(sleep),

					fitnessAge:
						unwrap(fitnessAge),

					spo2:
						unwrap(spo2),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 7. RECOVERY / WELLNESS RANGE
	// ========================================================

	server.registerTool(
		"garmin_recovery",
		{
			description:
				"Gets Garmin recovery trends over a date range including HRV, sleep, Body Battery, stress and daily summaries.",
			inputSchema: {
				startDate: z
					.string()
					.describe(
						"Start date in YYYY-MM-DD format.",
					),

				endDate: z
					.string()
					.describe(
						"End date in YYYY-MM-DD format.",
					),
			},
		},
		async ({
			startDate,
			endDate,
		}) => {
			try {
				const [
					hrv,
					sleep,
					bodyBattery,
					stress,
					summaries,
				] = await Promise.allSettled([
					garminGet(
						`/hrv-service/hrv/daily/${startDate}/${endDate}`,
					),

					garminGet(
						"/sleep-service/sleep/dailySleepSummariesByDate",
						{
							startDate,
							endDate,
						},
					),

					garminGet(
						"/wellness-service/wellness/bodyBattery/reports/daily",
						{
							startDate,
							endDate,
							chunks: 1,
						},
					),

					garminGet(
						`/usersummary-service/stats/stress/daily/${startDate}/${endDate}`,
					),

					garminGet(
						"/usersummary-service/v2/dailysummaries",
						{
							startDate,
							endDate,
						},
					),
				]);

				return textResult({
					startDate,
					endDate,

					hrv:
						unwrap(hrv),

					sleep:
						unwrap(sleep),

					bodyBattery:
						unwrap(bodyBattery),

					stress:
						unwrap(stress),

					dailySummaries:
						unwrap(summaries),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 8. STEPS + HYDRATION
	// ========================================================

	server.registerTool(
		"garmin_daily_stats",
		{
			description:
				"Gets Garmin steps and hydration over a date range.",
			inputSchema: {
				startDate: z
					.string()
					.describe(
						"Start date in YYYY-MM-DD format.",
					),

				endDate: z
					.string()
					.describe(
						"End date in YYYY-MM-DD format.",
					),
			},
		},
		async ({
			startDate,
			endDate,
		}) => {
			try {
				const [
					steps,
					hydration,
				] = await Promise.allSettled([
					garminGet(
						`/usersummary-service/stats/steps/daily/${startDate}/${endDate}`,
					),

					garminGet(
						`/usersummary-service/stats/hydration/daily/${startDate}/${endDate}`,
					),
				]);

				return textResult({
					startDate,
					endDate,

					steps:
						unwrap(steps),

					hydration:
						unwrap(hydration),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 9. WEIGHT / BODY COMPOSITION
	// ========================================================

	server.registerTool(
		"garmin_weight",
		{
			description:
				"Gets Garmin weight and body composition measurements over a date range.",
			inputSchema: {
				startDate: z
					.string()
					.describe(
						"Start date in YYYY-MM-DD format.",
					),

				endDate: z
					.string()
					.describe(
						"End date in YYYY-MM-DD format.",
					),
			},
		},
		async ({
			startDate,
			endDate,
		}) => {
			try {
				const data = await garminGet(
					`/weight-service/weight/range/${startDate}/${endDate}`,
					{
						includeAll: true,
					},
				);

				return textResult(data);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 10. NUTRITION
	// ========================================================

	server.registerTool(
		"garmin_nutrition",
		{
			description:
				"Gets Garmin food and nutrition logs for one date.",
			inputSchema: {
				date: z
					.string()
					.describe(
						"Date in YYYY-MM-DD format.",
					),
			},
		},
		async ({ date }) => {
			try {
				const data = await garminGet(
					`/nutrition-service/food/logs/${date}`,
				);

				return textResult(data);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 11. PROFILE + HEART RATE ZONES
	// ========================================================

	server.registerTool(
		"garmin_profile",
		{
			description:
				"Gets Garmin user profile settings and heart-rate zones.",
		},
		async () => {
			try {
				const [
					profile,
					zones,
				] = await Promise.allSettled([
					garminGet(
						"/userprofile-service/userprofile/settings",
					),

					garminGet(
						"/biometric-service/heartRateZones/v2",
					),
				]);

				return textResult({
					profile:
						unwrap(profile),

					heartRateZones:
						unwrap(zones),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ========================================================
	// 12. WELLNESS ACTIVITIES
	// ========================================================

	server.registerTool(
		"garmin_wellness_activities",
		{
			description:
				"Gets Garmin wellness activity summaries over a date range.",
			inputSchema: {
				startDate: z
					.string()
					.describe(
						"Start date in YYYY-MM-DD format.",
					),

				endDate: z
					.string()
					.describe(
						"End date in YYYY-MM-DD format.",
					),
			},
		},
		async ({
			startDate,
			endDate,
		}) => {
			try {
				const data = await garminGet(
					`/wellnessactivity-service/activity/summary/range/${startDate}/${endDate}`,
				);

				return textResult(data);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	return server;
}

// ============================================================
// MCP HANDLER
// ============================================================

const handler = createMcpHandler(createServer);

export default {
	fetch(
		request: Request,
		workerEnv: GarminEnv,
		ctx: ExecutionContext,
	) {
		return handler(
			request,
			workerEnv,
			ctx,
		);
	},
};
