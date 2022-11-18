import { DB_FILTER_ID, DB_USER_ID } from "./db";

export const VERSION = "1.0.0";

export const API_USER_CODE = "usercode";
export const API_FILTER_JSON = "filter";
export const API_PREVIOUS_FILTER_JSON = "prev-filter";
export const API_FILTER_ID = DB_FILTER_ID;
export const API_SUBSCRIPTION = "subscription";
export const API_SEND_TEST_NOTIFICATION = "sendtestnotif";

export const API_RESPONSE_FILTER_LIST = "filters";
/** The maximum number of subscribed devices/browsers a user can have. */
export const API_MAX_SUBSCRIPTIONS = 5;

export * from './geardata';

export const FE_WILDCARD = "Any";
export const FE_LOCAL_USER_CODE = DB_USER_ID;

export const FE_ERROR_404_MSG = "The server could not find your user ID. Please check your ID or make a new account.";
export const FE_ERROR_500_MSG = "The server returned an error (500). Please report if you keep seeing this message.";
export const FE_ERROR_INVALID_USERCODE = "Sorry, that usercode doesn't quite look right. Please check it and try again."