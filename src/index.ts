import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface GarminEnv {
	GARMIN_API_KEY: string;
}

const GARMIN_BASE = "https://personal.connectapi.garmin.com";
const TOKEN_URL =
	`${GARMIN_BASE}/personalapitoken-service/personal-api/personal-api-key/token`;

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

async function garminGet(
	env: GarminEnv,
	path: string,
	params?: Record<string, string | number | boolean | undefined>,
): Promise<any> {
	const token = await getGarminAccessToken(env.GARMIN_API_KEY);

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

	if (!text) return null;

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

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
	const message = error instanceof Error ? error.message : String(error);

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

function createServer(env: GarminEnv) {
	const server = new McpServer({
		name: "Garmin Connect SBL",
		version: "2.0.0",
	});

	// ---------------------------------------------------------
	// CONNECTION TEST
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_connection_status",
		{
			description: "Tests the secure Garmin Personal API connection.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				await getGarminAccessToken(env.GARMIN_API_KEY);
				return textResult({
					status: "connected",
					message: "Garmin Connect authentication successful.",
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ---------------------------------------------------------
	// ACTIVITIES
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_activities",
		{
			description:
				"Search Garmin activities by date and activity type. Use this for running, cycling, hiking and other activity history.",
			inputSchema: z.object({
				start: z.number().int().min(0).default(0),
				limit: z.number().int().min(1).max(100).default(20),
				startDate: z.string().optional(),
				endDate: z.string().optional(),
				activityType: z.string().optional(),
			}),
		},
		async ({ start, limit, startDate, endDate, activityType }) => {
			try {
				const data = await garminGet(
					env,
					"/activitylist-service/activities/search/activities",
					{
						start,
						limit,
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

	server.registerTool(
		"garmin_activity_details",
		{
			description:
				"Gets detailed Garmin data for one activity using its activity ID.",
			inputSchema: z.object({
				activityId: z.number().int().positive(),
			}),
		},
		async ({ activityId }) => {
			try {
				return textResult(
					await garminGet(
						env,
						`/activity-service/activity/${activityId}`,
					),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"garmin_activity_workouts",
		{
			description:
				"Gets workout information associated with a specific Garmin activity.",
			inputSchema: z.object({
				activityId: z.number().int().positive(),
			}),
		},
		async ({ activityId }) => {
			try {
				return textResult(
					await garminGet(
						env,
						`/activity-service/activity/${activityId}/workouts`,
					),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ---------------------------------------------------------
	// DAILY HEALTH — one tool can retrieve several signals
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_daily_health",
		{
			description:
				"Gets Garmin daily health information including daily summary, heart rate, HRV, sleep, fitness age and SpO2 for a date.",
			inputSchema: z.object({
				date: z.string().describe("Date in YYYY-MM-DD format"),
			}),
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
						env,
						"/usersummary-service/v2/dailysummaries",
						{ startDate: date, endDate: date },
					),
					garminGet(
						env,
						"/wellness-service/wellness/dailyHeartRate",
						{ date },
					),
					garminGet(env, `/hrv-service/hrv/${date}`),
					garminGet(
						env,
						"/sleep-service/sleep/dailySleep",
						{ date },
					),
					garminGet(
						env,
						`/fitnessage-service/fitnessage/v2/${date}`,
					),
					garminGet(
						env,
						`/wellness-service/wellness/daily/spo2acclimation/${date}`,
					),
				]);

				const unwrap = (r: PromiseSettledResult<any>) =>
					r.status === "fulfilled"
						? r.value
						: { unavailable: true, error: r.reason?.message ?? String(r.reason) };

				return textResult({
					date,
					dailySummary: unwrap(summary),
					heartRate: unwrap(heartRate),
					hrv: unwrap(hrv),
					sleep: unwrap(sleep),
					fitnessAge: unwrap(fitnessAge),
					spo2: unwrap(spo2),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ---------------------------------------------------------
	// RECOVERY / WELLNESS RANGE
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_recovery",
		{
			description:
				"Gets Garmin recovery and wellness trends over a date range: HRV, sleep, Body Battery, stress and daily summaries.",
			inputSchema: z.object({
				startDate: z.string(),
				endDate: z.string(),
			}),
		},
		async ({ startDate, endDate }) => {
			try {
				const [
					hrv,
					sleep,
					bodyBattery,
					stress,
					summaries,
				] = await Promise.allSettled([
					garminGet(
						env,
						`/hrv-service/hrv/daily/${startDate}/${endDate}`,
					),
					garminGet(
						env,
						"/sleep-service/sleep/dailySleepSummariesByDate",
						{ startDate, endDate },
					),
					garminGet(
						env,
						"/wellness-service/wellness/bodyBattery/reports/daily",
						{
							startDate,
							endDate,
							chunks: 1,
						},
					),
					garminGet(
						env,
						`/usersummary-service/stats/stress/daily/${startDate}/${endDate}`,
					),
					garminGet(
						env,
						"/usersummary-service/v2/dailysummaries",
						{ startDate, endDate },
					),
				]);

				const unwrap = (r: PromiseSettledResult<any>) =>
					r.status === "fulfilled"
						? r.value
						: { unavailable: true, error: r.reason?.message ?? String(r.reason) };

				return textResult({
					startDate,
					endDate,
					hrv: unwrap(hrv),
					sleep: unwrap(sleep),
					bodyBattery: unwrap(bodyBattery),
					stress: unwrap(stress),
					dailySummaries: unwrap(summaries),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ---------------------------------------------------------
	// STEPS / HYDRATION
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_daily_stats",
		{
			description:
				"Gets Garmin steps and hydration statistics over a date range.",
			inputSchema: z.object({
				startDate: z.string(),
				endDate: z.string(),
			}),
		},
		async ({ startDate, endDate }) => {
			try {
				const [steps, hydration] = await Promise.allSettled([
					garminGet(
						env,
						`/usersummary-service/stats/steps/daily/${startDate}/${endDate}`,
					),
					garminGet(
						env,
						`/usersummary-service/stats/hydration/daily/${startDate}/${endDate}`,
					),
				]);

				const unwrap = (r: PromiseSettledResult<any>) =>
					r.status === "fulfilled"
						? r.value
						: { unavailable: true, error: r.reason?.message ?? String(r.reason) };

				return textResult({
					startDate,
					endDate,
					steps: unwrap(steps),
					hydration: unwrap(hydration),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ---------------------------------------------------------
	// WEIGHT
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_weight",
		{
			description:
				"Gets Garmin weight and body composition measurements over a date range.",
			inputSchema: z.object({
				startDate: z.string(),
				endDate: z.string(),
			}),
		},
		async ({ startDate, endDate }) => {
			try {
				return textResult(
					await garminGet(
						env,
						`/weight-service/weight/range/${startDate}/${endDate}`,
						{ includeAll: true },
					),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ---------------------------------------------------------
	// NUTRITION
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_nutrition",
		{
			description:
				"Gets Garmin food and nutrition logs for a calendar date.",
			inputSchema: z.object({
				date: z.string(),
			}),
		},
		async ({ date }) => {
			try {
				return textResult(
					await garminGet(
						env,
						`/nutrition-service/food/logs/${date}`,
					),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ---------------------------------------------------------
	// PROFILE / PHYSIOLOGY
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_profile",
		{
			description:
				"Gets Garmin profile settings and heart-rate zones.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const [profile, zones] = await Promise.allSettled([
					garminGet(
						env,
						"/userprofile-service/userprofile/settings",
					),
					garminGet(
						env,
						"/biometric-service/heartRateZones/v2",
					),
				]);

				const unwrap = (r: PromiseSettledResult<any>) =>
					r.status === "fulfilled"
						? r.value
						: { unavailable: true, error: r.reason?.message ?? String(r.reason) };

				return textResult({
					profile: unwrap(profile),
					heartRateZones: unwrap(zones),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	// ---------------------------------------------------------
	// WELLNESS ACTIVITIES
	// ---------------------------------------------------------

	server.registerTool(
		"garmin_wellness_activities",
		{
			description:
				"Gets Garmin wellness activity summaries over a date range.",
			inputSchema: z.object({
				startDate: z.string(),
				endDate: z.string(),
			}),
		},
		async ({ startDate, endDate }) => {
			try {
				return textResult(
					await garminGet(
						env,
						`/wellnessactivity-service/activity/summary/range/${startDate}/${endDate}`,
					),
				);
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	return server;
}

export default {
	fetch(request: Request, env: GarminEnv, ctx: ExecutionContext) {
		const handler = createMcpHandler(() => createServer(env));
		return handler(request, env, ctx);
	},
};
