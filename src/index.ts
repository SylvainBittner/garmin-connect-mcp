import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface GarminEnv {
	GARMIN_API_KEY: string;
}

async function getGarminAccessToken(apiKey: string): Promise<string> {
	const response = await fetch(
		"https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token",
		{
			method: "POST",
			headers: {
				Authorization: `ApiKey ${apiKey}`,
			},
		},
	);

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

function createServer(env: GarminEnv) {
	const server = new McpServer({
		name: "Garmin Connect SBL",
		version: "1.0.0",
	});

	server.registerTool(
		"garmin_connection_status",
		{
			description:
				"Tests the secure connection to the user's Garmin Connect Personal API.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				await getGarminAccessToken(env.GARMIN_API_KEY);

				return {
					content: [
						{
							type: "text",
							text: "Garmin Connect authentication successful.",
						},
					],
				};
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);

				return {
					content: [
						{
							type: "text",
							text: `Garmin Connect authentication failed: ${message}`,
						},
					],
				};
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
