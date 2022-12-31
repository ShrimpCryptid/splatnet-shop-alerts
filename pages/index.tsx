import Head from "next/head";
import Link from "next/link";
import Router from "next/router";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import FilterView from "../components/filter-view";
import styles from "../styles/index.module.css";
import {
	API_FILTER_JSON,
	API_NICKNAME,
	API_SEND_TEST_NOTIFICATION,
	API_SUBSCRIPTION,
	API_USER_CODE,
	FE_ERROR_INVALID_USERCODE,
	FE_LOCAL_SUBSCRIPTION_INFO,
	FE_UNKNOWN_MSG,
} from "../constants";
import { DefaultPageProps } from "./_app";
import {
	requestNotificationPermission,
  registerServiceWorker,
	createNotificationSubscription,
} from "../lib/notifications";
import SuperJumpLoadAnimation from "../components/superjump/superjump";
import { fetchWithAttempts, getRandomTitle, isValidNickname, isValidUserCode, printStandardErrorMessage, sanitizeNickname, sleep } from "../lib/shared_utils";
import LoadingButton, { ButtonStyle } from "../components/loading-button";
import LabeledAlertbox, { NotificationAlertbox, WelcomeAlertbox } from "../components/alertbox";
import Switch from "../components/switch";
import { makeIcon, makeIconHeader } from "../lib/frontend_utils";

enum NEW_USER_FLOW {
  NONE=0,
  NICKNAME_PROMPT=1,
  NOTIFICATION_PROMPT=2,
}

export default function Home({
	userCode,
	setUserCode,
	setEditingFilterIndex,
	updateLocalUserData,
	userFilters,
  userNickname,
  isUserNew,
  setIsUserNew,
	setUserFilters,
  setUserNickname,
}: DefaultPageProps) {
	// Flags for UI loading buttons
	/** The index of any filter we are waiting to edit. -1 by default. */
	let [awaitingEdit, setAwaitingEdit] = useState(-1);
	/** The index of any filters we are waiting to delete. -1 by default. */
	let [awaitingDelete, setAwaitingDelete] = useState(-1);
	/** Whether we are currently awaiting updated user data. */
	let [awaitingRefresh, setAwaitingRefresh] = useState(false);
	/** Whether we are currently waiting for the new filter page to load. */
	let [awaitingNewFilter, setAwaitingNewFilter] = useState(false);
  let [awaitingLogin, setAwaitingLogin] = useState(false);
  let [awaitingUpdateNickname, setAwaitingUpdateNickname] = useState(false);

  let [visiblePrompt, setVisiblePrompt] = useState(NEW_USER_FLOW.NONE);

	let [pageSwitchReady, setPageSwitchReady] = useState(false);

	let [notificationsToggle, setNotificationsToggle] = useState(false);
  let [notificationsLoading, setNotificationsLoading] = useState(false);

  let [showLogoutPrompt, setShowLogoutPrompt] = useState(false);
  
	let [loginUserCode, setLoginUserCode] = useState("");

	// Retrieve the user's filters from the database.
	const updateFilterViews = async () => {
		setAwaitingRefresh(true);
		if (userCode === null || userCode === undefined) {
			// There is no user to retrieve data for, so we do not attempt to load.
			// Delay reset so user knows that an action is being taken.
			sleep(500).then(() => setAwaitingRefresh(false));
		} else {
			// Request latest user data
			updateLocalUserData(userCode, true).then(() => {
				sleep(500).then(() => setAwaitingRefresh(false));
			});
		}
	};

	/** Edit an existing filter */
	const onClickEditFilter = (filterIndex: number) => {
		// Switch page contexts, save the editing filter to the state.
		if (userFilters && !pageSwitchReady) {
			setEditingFilterIndex(filterIndex);
			setAwaitingEdit(filterIndex);
			setPageSwitchReady(true);
		}
	};

	// Switches page to the filter edit/creation, but only when state has finished
	// changing.
	useEffect(() => {
		// Manually prefetch the filters page (since we're not using a Next.js Link
		// which normally handles this for us!).
		Router.prefetch("filter");
		if (pageSwitchReady) {
			Router.push("filter");
		}
	});

	/** Attempts to delete the filter given by the index from the server. */
	const onClickDeleteFilter = (filterIndex: number) => {
		async function deleteFilter(filterIndex: number) {
			if (userFilters && filterIndex >= 0 && filterIndex < userFilters.length) {
				try {
					let filter = userFilters[filterIndex];
					// Query the backend, requesting deletion
					let url = `/api/delete-filter?${API_USER_CODE}=${userCode}`;
					url += `&${API_FILTER_JSON}=${filter.serialize()}`;
					let result = await fetch(url);
					if (result.status == 200) {
						// Remove filter from the list locally too
						let newUserFilters = [...userFilters]; // shallow copy
						newUserFilters.splice(filterIndex, 1);
						setUserFilters(newUserFilters);
					} else {
            toast.error(FE_UNKNOWN_MSG + " (error: " + result.status + ")");
					}
				} catch (e) {
					toast.error(FE_UNKNOWN_MSG);
				}
			}
			setAwaitingDelete(-1);
		}
		setAwaitingDelete(filterIndex);
		deleteFilter(filterIndex);
	};

  // Notification initial state is defined by whether we local subscription info
  // stored, AND there's a service worker currently running.
  useEffect(() => {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.getRegistration().then((registration) => {
        setNotificationsToggle(
          window && window.localStorage.getItem(FE_LOCAL_SUBSCRIPTION_INFO) !== null
          && registration !== undefined && Notification.permission === "granted");
      });
    }
  })

  /** 
   * Toggles notification state on/off, logging the subscriber information with
   * the backend.
   * 
   * Returns true if the operation was completed successfully. Returns false if
   * an explicit error was encountered. Returns null if the operation was
   * cancelled by the user but could be reattempted.
   */
	const toggleNotifications = async (newState: boolean) => {
    setNotificationsLoading(true);
		if (newState) {  // Turn ON notifications
      try {
        // Stop if user doesn't have an account yet.
        if (userCode === null || userCode === undefined) {
          toast("Make a filter first to enable notifications!");
          return false;
        }

        // Request permission for notifications, and handle cases where the user
        // denies the permission.
        if (Notification.permission !== "granted") {
          await requestNotificationPermission();
        }
        if (Notification.permission === "default") {
          // User closed notification prompt without selecting an option
          return null;
        } else if (Notification.permission !== "granted") {
          // User denied notifications
          toast.error("Notifications have been disabled. Check the webpage settings in your browser to reenable them.");
          return false;
        }

        await registerServiceWorker();
  
        const publicVAPIDKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
        if (!publicVAPIDKey) {
          console.error("Cannot find public VAPID key environment variable.");
          return;
        }
        // TODO: Handle 'DOMException: Registration failed' when VAPID keys have changed. => instead, handle when loading initial status
        let subscription = await createNotificationSubscription(publicVAPIDKey);
        let subscriptionString = JSON.stringify(subscription);
  
        // Send the subscription data to the server and save.
        let url = `/api/subscribe?${API_SUBSCRIPTION}=${subscriptionString}`;
        url += `&${API_USER_CODE}=${userCode}`;
        url += `&${API_SEND_TEST_NOTIFICATION}`; // flag: send test notif.
        let result = await fetchWithAttempts(url, 3, [200, 404]);

        if (result && result.status === 200) {
          toast.success("Success! A test notification has been sent to your device.");
          setNotificationsToggle(true);
          // Save subscription info to local state
          if (window) {
            window.localStorage.setItem(FE_LOCAL_SUBSCRIPTION_INFO, subscriptionString);
          }
          return true;
        } else {
          printStandardErrorMessage(result);
          return false;
        }
      } catch (e) {
        console.log(e);
        toast.error(FE_UNKNOWN_MSG);
        return false;
      } finally {
        // Add a slight delay so users know that something is happening
        sleep(500).then(() => setNotificationsLoading(false));
      }

		} else { // Turn OFF notifications
      // Unregister all local service workers
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (let registration of registrations) {
          registration.unregister();
        }
      });
      if (window) {
        let subscriptionString = window.localStorage.getItem(FE_LOCAL_SUBSCRIPTION_INFO);
        if (subscriptionString) {
          // Some saved subscription information, so attempt to remove from server
          // (This is just a courtesy, as the server will auto-delete failed
          // service workers when notifying them.)
          let url = `/api/unsubscribe?${API_SUBSCRIPTION}=${subscriptionString}`;
          url += `&${API_USER_CODE}=${userCode}`;
          await fetchWithAttempts(url, 3, [200, 400, 404]);
        }
        // Clear stored subscription information
        window.localStorage.removeItem(FE_LOCAL_SUBSCRIPTION_INFO);
      }
			toast("Notifications have been disabled for this device.");
			setNotificationsToggle(false);
      setNotificationsLoading(false);
      return true;
    }
	};

	/** Updates the login field as the user types. */
	const handleLoginChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
		setLoginUserCode(event.currentTarget.value);
	};

	const onClickLogin = () => {
    let formattedUserCode = loginUserCode.trim();

		if (!isValidUserCode(formattedUserCode)) {
			toast.error(FE_ERROR_INVALID_USERCODE);
			return;
		}
    setAwaitingLogin(true);
		updateLocalUserData(formattedUserCode, true, false).then(([succeeded, values]) => {
      if (succeeded) {
        // Update our local user code
        setUserCode(formattedUserCode);
        setLoginUserCode(""); // blank login box
        toast.success("Logged in as '" + values.nickname + "'!");
      }
      setAwaitingLogin(false);
    });
	};

  /** Handle page flow and nickname/notification prompts */
  useEffect(() => {
    // Advance to the first login prompt
    if (isUserNew && visiblePrompt === NEW_USER_FLOW.NONE) {
      setVisiblePrompt(NEW_USER_FLOW.NICKNAME_PROMPT);
      setIsUserNew(false);
    }
    // Advance to the notification prompt once a nickname is set
    if (visiblePrompt === NEW_USER_FLOW.NICKNAME_PROMPT && userNickname && isValidNickname(userNickname)) {
      setVisiblePrompt(NEW_USER_FLOW.NOTIFICATION_PROMPT);
    }
  })

  let [tempUserNickname, setTempUserNickname] = useState(userNickname);
  useEffect(() => {
    if (userNickname === null || userNickname === undefined) {
      setTempUserNickname(userNickname);
    } else if (tempUserNickname === null || tempUserNickname === undefined) {
      setTempUserNickname(sanitizeNickname(userNickname));
    }
  })

  const onChangedNickname = async (event: React.ChangeEvent<HTMLTextAreaElement>) => {
		setTempUserNickname(sanitizeNickname(event.currentTarget.value));
	};

  /** Update the nickname of a user! */
  const onClickUpdateNickname = async (nickname: string) => {
    setAwaitingUpdateNickname(true);
    try {
      let encodedNickname = encodeURIComponent(nickname);
      let url = `/api/update-nickname?${API_NICKNAME}=${encodedNickname}`
      url += `&${API_USER_CODE}=${userCode}`
      let response = await fetchWithAttempts(url, 3, [200, 400, 404])
      if (!response) {
        toast.error(FE_UNKNOWN_MSG);
        return;
      }
      if (response.status === 200) { // Get updated nickname from the JSON body
        let savedNickname = await response.json();
        setUserNickname(savedNickname);
        toast.success("Nickname saved as '" + savedNickname + "'!");
      } else {
        printStandardErrorMessage(response);
      }
    } catch (e) {
      toast.error(FE_UNKNOWN_MSG);
    } finally {
      setAwaitingUpdateNickname(false);
    }
  }

	// Set different text prompts for the filter loading screen
	let loadingText = "Loading...";
	if (userCode === null) {
		// No user filters could be loaded because the user does not exist yet.
		loadingText = "There's nothing here yet. Make a new filter or log in to get started!";
	} else if (userFilters && userFilters.length === 0) {
		// User was loaded but has no filters.
		loadingText = "There's nothing here yet.";
	}
	// Otherwise, filter list will be shown instead.

	return (
		<div className={styles.main}>

      {visiblePrompt === NEW_USER_FLOW.NICKNAME_PROMPT ?
        <WelcomeAlertbox
          onClickSubmit={onClickUpdateNickname}
          usercode={userCode ? userCode : ""}
          loading={awaitingUpdateNickname}
        /> : <></>
      }

      {visiblePrompt === NEW_USER_FLOW.NOTIFICATION_PROMPT ?
      <NotificationAlertbox
        onClickCancel={() => {
          setVisiblePrompt(NEW_USER_FLOW.NONE);
          toast("Notifications can be enabled at any time from the Settings pane.");
        }}
        onClickSignUp={() => {
          toggleNotifications(true).then((result) => {
            if (result === true) {
              // Succeeded, close dialog
              setVisiblePrompt(NEW_USER_FLOW.NONE);
            }
          })
        }}
        loading={notificationsLoading}
      />
      : <></>}

      {showLogoutPrompt ? 
        <LabeledAlertbox
          header="Log Out"
          onClickClose={() => setShowLogoutPrompt(false)}
          primaryButton="Log Out"
          primaryButtonOnClick={() => {
            toast("Logged out successfully. (user: " + userCode + ")");
            setUserCode(null);
            updateLocalUserData(null, false, true);  // force cleaning user data
            setShowLogoutPrompt(false);
            setTempUserNickname(null);
          }}
          secondaryButton="Cancel"
          secondaryButtonOnClick={() => setShowLogoutPrompt(false)}
        >
          <p>Are you sure you want to log out?</p>
          <p><b className="highlight">Please make sure you've saved your user ID
            somewhere safe as your account cannot be recovered without it!</b>
          </p>
        </LabeledAlertbox> :
        <></>
      }

      <div className={"panel"}>
        
        <h1
          className={styles.centered}
          style={{marginTop: "10px"}}
        >
          {typeof userNickname === "string" ?
            <>
              Welcome back, <span className="highlight">{userNickname}</span>!
            </>
            :
            <>Welcome!</>}
        </h1>

        <div
          style={{
            display: "flex",
            flexDirection: "row",
            verticalAlign: "bottom",
            justifyContent: "space-between",
            margin: "10px 0"
          }}
        >
          <h2 style={{marginTop: "auto"}}>Your Filters</h2>
          <LoadingButton
            onClick={updateFilterViews}
            loading={awaitingRefresh}
            disabled={!userCode}
          >
            Refresh
          </LoadingButton>
        </div>
        <div className={styles.filterListContainer}>
          {userFilters && userFilters.length > 0 ? (
            // User has filters, so we can show them the filter list!
            userFilters.map((filter, index) => {
              return (
                <FilterView
                  onClickEdit={() => onClickEditFilter(index)}
                  onClickDelete={() => onClickDeleteFilter(index)}
                  awaitingEdit={index === awaitingEdit}
                  awaitingDelete={index === awaitingDelete}
                  filter={filter}
                  key={index}
                />
              );
            })
          ) : (
            // Show loading animation and text
            <div className={styles.emptyFilterList}>
              <SuperJumpLoadAnimation filterText={loadingText} fillLevel={0.5} />
            </div>
          )}
        </div>
        <LoadingButton
          onClick={() => {
            setEditingFilterIndex(null); // clear any filters being edited
            setAwaitingNewFilter(true); // set loading animation on new filter
            setPageSwitchReady(true); // ready page to transition
          }}
          loading={awaitingNewFilter}
          disabled={awaitingEdit !== -1}
        >
          New Filter
        </LoadingButton>
      </div>

      <div className={"panel"}>
        <h3 className={styles.centered}>Get notified about gear from the SplatNet 3 app!</h3>
        <p>
          Splatnet Alerts lets you sign up for notifications about new gear items.
          You can set <b>filters</b> to search for certain brand, ability, or gear
          combinations, and sync notifications across devices. You'll be notified
          within 30 minutes of new items arriving in the shop!
          <br />
          <br />
          Splatnet Alerts is maintained by <Link href="https://twitter.com/ShrimpCryptid">@ShrimpCryptid</Link>. You can contribute
          directly to the project on <Link href="https://github.com/ShrimpCryptid/splatnet-shop-alerts">GitHub</Link>!
        </p>
      </div>
      
      <div className={"panel"}>
        <h1 style={{marginBottom: "10px"}}>{makeIconHeader("settings_suggest", "Settings", styles.centeredDiv, "md-36")}</h1>
      
        {makeIconHeader("notifications", "Notifications: " + (notificationsToggle ? "ON" : "OFF"), "highlight")}
        <p style={{marginBottom: "0"}}>
          SplatNet Alerts sends push notifications via your browser. You can turn
          off notifications at any time.</p>
        <Switch 
          state={notificationsToggle}
          onToggled={toggleNotifications}
          loading={notificationsLoading}
          disabled={false  /** TODO: Check if push is supported by browser */}
        />
        <br/>
        <br/>

        {makeIconHeader("badge", "Nickname", "highlight")}
        <p style={{ marginTop: "0" }}>
          Set a nickname to remember this account by. You can also generate a
          random in-game title using the button.
          <br/><i>(Limited to alphanumeric characters, dashes, and spaces!)</i>
        </p>
        <div className={styles.hdivWrap}>
          <textarea value={tempUserNickname ? tempUserNickname : ""} onChange={onChangedNickname} />
          <LoadingButton
            buttonStyle={ButtonStyle.ICON}
            onClick={() => setTempUserNickname(getRandomTitle())}
          >
            {/** TODO: Add descriptive alt text to refresh button */}
            {makeIcon("refresh")}
          </LoadingButton>
          <LoadingButton
            onClick={() => {onClickUpdateNickname(tempUserNickname? tempUserNickname : "")}}
            disabled={userCode === null || userCode === undefined}
          >
            Update
          </LoadingButton>
        </div>
        <br/>
        
        {makeIconHeader("account_box", "User ID", "highlight")}
        <p style={{marginTop: "0"}}>This is your unique user ID. Save and copy this somewhere secure!<br/>
          You can use it to make changes to your notifications if you clear your
          cookies or use another browser.
        </p>
        <p style={{marginBottom: "2px"}}>
          <b>Your user ID is:</b>
        </p>
        <div className={styles.hdivWrap}>
          <textarea value={userCode ? userCode : ""} readOnly={true} />
          <LoadingButton buttonStyle={ButtonStyle.ICON}
            onClick={() => {
              navigator.clipboard.writeText(userCode ? userCode : "");
              toast("Copied to clipboard!");
            }}
            disabled={!userCode || userCode === ""}
          >
            {makeIcon("content_copy")}
          </LoadingButton>
          <LoadingButton
            onClick={() => {setShowLogoutPrompt(true)}}
            loading={showLogoutPrompt}
          >
            Log Out
          </LoadingButton>
        </div>
        
        <br/>
        {makeIconHeader("switch_account", "Change User", "highlight")}
        <p style={{marginTop: "0"}}>
          Paste in your user ID to sync your notification settings across devices.
        </p>
        <div className={styles.hdivWrap}>
          <textarea value={loginUserCode} onChange={handleLoginChange} />
          <LoadingButton
            onClick={onClickLogin}
            loading={awaitingLogin}
            disabled={!isValidUserCode(loginUserCode.trim())}
          > 
            {makeIcon("login")} Login
          </LoadingButton>
        </div>
      </div>
    </div>
	);
}
