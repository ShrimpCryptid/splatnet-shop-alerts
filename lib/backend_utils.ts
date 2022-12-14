import webpush from "web-push";
import fetch from "node-fetch";
import { VERSION } from "../constants";
import {
	ENV_KEY_DEV_EMAIL,
	ENV_KEY_SPLATNET_URL,
	ENV_KEY_VAPID_PRIVATE,
	ENV_KEY_VAPID_PUBLIC,
  ENV_KEY_WEBSITE_URL,
} from "../constants/env";
import { getEnvWithDefault } from "./shared_utils";

export const BASE_SPLATNET_URL = getEnvWithDefault(ENV_KEY_SPLATNET_URL, "/");
export const BASE_WEBSITE_URL = getEnvWithDefault(ENV_KEY_WEBSITE_URL, "/");

/**
 * Sets up the webpush configuration using the environment variables, including
 * the public and private VAPID keys and contact information.
 */
export function configureWebPush() {
	webpush.setVapidDetails(
		`mailto:${getEnvWithDefault(ENV_KEY_DEV_EMAIL, "")}`,
		getEnvWithDefault(ENV_KEY_VAPID_PUBLIC, ""),
		getEnvWithDefault(ENV_KEY_VAPID_PRIVATE, "")
	);
}

/**
 * Calls fetch on the given request.
 */
export async function fetchWithBotHeader(url: string) {
	return fetch(url, {
		method: "GET",
		headers: {
			"User-Agent": `Splatnet Shop Alerts Prototype/${VERSION} ${getEnvWithDefault(
				ENV_KEY_DEV_EMAIL,
				""
			)}`,
		},
	});
}
