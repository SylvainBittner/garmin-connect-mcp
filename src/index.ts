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

	// Garmin retourne directement le JWT comme texte,
	// et non comme objet JSON.
	const token = (await response.text()).trim();

	if (!token) {
		throw new Error("Garmin returned no access token.");
	}

	return token;
}
