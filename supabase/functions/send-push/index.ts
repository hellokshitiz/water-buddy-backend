import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// --- 1. NATIVE CRYPTO HELPER ---
async function getAccessToken(serviceAccount: any) {
  try {
    // DEBUG: Explicit check before usage
    if (!serviceAccount.private_key) throw new Error("CRITICAL: 'private_key' field is MISSING in Service Account JSON");
    if (!serviceAccount.client_email) throw new Error("CRITICAL: 'client_email' field is MISSING in Service Account JSON");

    const pemHeader = "-----BEGIN PRIVATE KEY-----";
    const pemFooter = "-----END PRIVATE KEY-----";
    const pemContents = serviceAccount.private_key.replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
    
    const binaryDerString = atob(pemContents);
    const binaryDer = new Uint8Array(binaryDerString.length);
    for (let i = 0; i < binaryDerString.length; i++) { binaryDer[i] = binaryDerString.charCodeAt(i); }
    
    const key = await crypto.subtle.importKey(
      "pkcs8", binaryDer, 
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, 
      false, ["sign"]
    );

    const now = Math.floor(Date.now() / 1000);
    const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
    const payload = JSON.stringify({ 
      iss: serviceAccount.client_email, 
      scope: "https://www.googleapis.com/auth/firebase.messaging", 
      aud: "https://oauth2.googleapis.com/token", 
      exp: now + 3600, iat: now 
    });

    const base64UrlEncode = (str: string) => btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const unsignedToken = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsignedToken));
    const signedJwt = `${unsignedToken}.${base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)))}`;

    console.log("[Crypto] Exchanging JWT for Access Token...");
    const res = await fetch("https://oauth2.googleapis.com/token", { 
      method: "POST", 
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, 
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt }) 
    });

    const data = await res.json();
    if (!res.ok) throw new Error(`Google Auth Failed: ${JSON.stringify(data)}`);
    return data.access_token;
  } catch (e) {
    console.error("[Crypto Error]", e.message);
    throw e;
  }
}

// --- 2. MAIN HANDLER ---
serve(async (req) => {
  console.log(`\n--- INCOMING REQUEST ---`);
  
  try {
    const bodyText = await req.text();
    if (!bodyText) throw new Error("Empty Request Body");
    const { record } = JSON.parse(bodyText);
    console.log(`Target Profile: ${record.recipient_profile_id}`);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get FCM Token
    const { data: tokenData } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('profile_id', record.recipient_profile_id)
      .maybeSingle();

    if (!tokenData) {
      console.log(`No token found.`);
      return new Response(JSON.stringify({ error: "No Token" }), { headers: { "Content-Type": "application/json" } });
    }

    // --- DEBUGGING THE SECRET ---
    const serviceAccountJson = Deno.env.get('SERVICE_ACCOUNT_JSON');
    if (!serviceAccountJson) throw new Error("Missing SERVICE_ACCOUNT_JSON env var");
    
    let serviceAccount;
    try {
        serviceAccount = JSON.parse(serviceAccountJson);
    } catch (e) {
        throw new Error(`SERVICE_ACCOUNT_JSON is malformed: ${e.message}`);
    }

    // PRINT THE KEYS to confirm structure (Safe to log)
    console.log("Service Account Keys Found:", Object.keys(serviceAccount));

    // Get Access Token
    const accessToken = await getAccessToken(serviceAccount);

    // Send to Firebase
    console.log(`Sending to FCM Token: ${tokenData.token.substring(0, 10)}...`);
    const fcmRes = await fetch(
      `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message: {
            token: tokenData.token,
            notification: { title: record.title, body: record.body },
            data: { type: 'nudge', payload: JSON.stringify(record.payload || {}) }
          },
        }),
      }
    );

    const fcmResult = await fcmRes.json();
    console.log("FCM Response:", JSON.stringify(fcmResult));
    return new Response(JSON.stringify(fcmResult), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("FATAL CRASH:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
})