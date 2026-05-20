import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';

const FIREBASE_APP_SCRIPT = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js';
const FIREBASE_AUTH_SCRIPT = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js';
const FIREBASE_FIRESTORE_SCRIPT = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js';
const NATIVE_GOOGLE_SETUP_HINT = 'Android Google sign-in needs Firebase Android setup. Add android/app/google-services.json for com.bariyaone.stockone and register the app SHA fingerprints in Firebase.';

let firebaseReadyPromise;

function isAndroidUserAgent() {
  if (typeof navigator === 'undefined') return false;
  return /android/i.test(navigator.userAgent || '');
}

function getFirebaseConfig() {
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
}

export function isFirebaseConfigured() {
  const config = getFirebaseConfig();
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

export function isNativeFirebasePlatform() {
  return Capacitor.isNativePlatform();
}

export function isNativeFirebasePluginAvailable() {
  try {
    return Capacitor.isPluginAvailable('FirebaseAuthentication');
  } catch {
    return false;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

export async function loadFirebaseAuth() {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase environment variables are missing.');
  }

  if (!firebaseReadyPromise) {
    firebaseReadyPromise = (async () => {
      await loadScript(FIREBASE_APP_SCRIPT);
      await loadScript(FIREBASE_AUTH_SCRIPT);

      const firebase = window.firebase;
      if (!firebase) {
        throw new Error('Firebase SDK did not load.');
      }

      if (!firebase.apps.length) {
        firebase.initializeApp(getFirebaseConfig());
      }

      try {
        await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
      } catch {
        // Ignore persistence setup issues and keep auth usable.
      }

      return { firebase, auth: firebase.auth() };
    })();
  }

  return firebaseReadyPromise;
}

export async function loadFirebaseDataLayer() {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase environment variables are missing.');
  }

  const { firebase, auth } = await loadFirebaseAuth();
  await loadScript(FIREBASE_FIRESTORE_SCRIPT);

  if (!firebase.firestore) {
    throw new Error('Firebase Firestore SDK did not load.');
  }

  return {
    firebase,
    auth,
    db: firebase.firestore(),
  };
}

async function signInWithGooglePopup() {
  const { firebase, auth } = await loadFirebaseAuth();
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return auth.signInWithPopup(provider);
}

function createGoogleSignInError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Google sign-in failed.');
  const normalized = message.toLowerCase();

  if (
    normalized.includes('not implemented on android') ||
    normalized.includes('not implemented on web') ||
    normalized.includes('plugin is not implemented') ||
    normalized.includes('firebaseauthentication') && normalized.includes('not implemented')
  ) {
    return new Error('Native Firebase plugin unavailable in this build. Reinstall the Android app from the latest APK and open the installed app, not the browser page.');
  }

  if (
    normalized.includes('missing initial state') ||
    normalized.includes('sessionstorage') ||
    normalized.includes('storage-partitioned') ||
    normalized.includes('redirect')
  ) {
    return new Error('Web redirect sign-in is not supported in this Android app. Use the native Google sign-in flow instead.');
  }

  if (
    normalized.includes('developer error') ||
    normalized.includes('12500') ||
    normalized.includes('10:') ||
    normalized.includes('server client id') ||
    normalized.includes('default_web_client_id') ||
    normalized.includes('will_be_overridden')
  ) {
    return new Error(`${NATIVE_GOOGLE_SETUP_HINT} Original error: ${message}`);
  }

  return error instanceof Error ? error : new Error(message);
}

async function signInWithGoogleNative() {
  const { firebase, auth } = await loadFirebaseAuth();

  if (!isNativeFirebasePluginAvailable()) {
    throw new Error('Native Firebase plugin unavailable in this build. Reinstall the Android app from the latest APK and open the installed app, not the browser page.');
  }

  try {
    const result = await FirebaseAuthentication.signInWithGoogle({
      skipNativeAuth: true,
      useCredentialManager: true,
    });

    const idToken = result?.credential?.idToken ?? null;
    const accessToken = result?.credential?.accessToken ?? null;

    if (!idToken && !accessToken) {
      throw new Error('Native Google sign-in returned no Firebase credential.');
    }

    const credential = firebase.auth.GoogleAuthProvider.credential(idToken, accessToken);
    await auth.signInWithCredential(credential);
    return auth.currentUser;
  } catch (error) {
    throw createGoogleSignInError(error);
  }
}

export async function signInWithGoogle() {
  if (!isNativeFirebasePlatform() && isAndroidUserAgent()) {
    throw new Error('Open the installed Android app to use Google sign-in. The mobile browser page does not support the native Firebase sign-in flow.');
  }

  if (isNativeFirebasePlatform()) {
    return signInWithGoogleNative();
  }

  try {
    return await signInWithGooglePopup();
  } catch (error) {
    throw createGoogleSignInError(error);
  }
}

export async function signOutFirebase() {
  const { auth } = await loadFirebaseAuth();
  await auth.signOut();

  if (isNativeFirebasePlatform()) {
    try {
      await FirebaseAuthentication.signOut();
    } catch {
      // Native sign-out cleanup is best-effort only.
    }
  }
}
