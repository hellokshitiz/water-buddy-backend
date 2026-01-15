import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// --------------------------------------------------------------------------
// PURE WEB CRYPTO IMPLEMENTATION (No External Auth Libraries)
// --------------------------------------------------------------------------
async function getAccessToken({ client_email, private_key }: { client_email: string; private_key: string }) {
  // 1. Clean the private key
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = private_key
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s/g, "");

  // 2. Import Key
  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  // 3. Create JWT Header & Payload
  const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    iss: client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  });

  const base64UrlEncode = (str: string) =>
    btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const unsignedToken = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

  // 4. Sign
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const signedJwt = `${unsignedToken}.${base64UrlEncode(
    String.fromCharCode(...new Uint8Array(signature))
  )}`;

  // 5. Exchange for Access Token
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signedJwt,
    }),
  });

  const data = await res.json();
  return data.access_token;
}

// --------------------------------------------------------------------------
// MAIN HANDLER
// --------------------------------------------------------------------------
serve(async (req) => {
  try {
    // 1. Security Check (Manual Service Role Auth)
    const authHeader = req.headers.get('Authorization')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    
    if (!authHeader || !serviceRoleKey || !authHeader.includes(serviceRoleKey)) {
       return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    }

    const { record } = await req.json()
    
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 2. Get Recipient Token
    const { data: tokenData, error: tokenError } = await supabase
      .from('fcm_tokens')
      .select('token')
      .eq('profile_id', record.recipient_profile_id)
      .maybeSingle()

    if (!tokenData) {
      console.log(`No token for: ${record.recipient_profile_id}`)
      await supabase.from('notifications').update({ delivery_status: 'failed_no_token' }).eq('id', record.id)
      return new Response("No token", { status: 200 }) 
    }

    // 3. Get Google Access Token (Native Way)
    const serviceAccountJson = Deno.env.get('SERVICE_ACCOUNT_JSON')
    if (!serviceAccountJson) throw new Error("Missing SERVICE_ACCOUNT_JSON")
    const serviceAccount = JSON.parse(serviceAccountJson)
    
    const accessToken = await getAccessToken(serviceAccount)

    // 4. Send to FCM
    console.log(`Sending to: ${tokenData.token.substring(0, 10)}...`)
    
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
            notification: { 
                title: record.title, 
                body: record.body 
            },
            data: { 
                click_action: "FLUTTER_NOTIFICATION_CLICK", 
                type: record.type || 'nudge',
                payload: JSON.stringify(record.payload || {})
            }
          },
        }),
      }
    )

    const result = await fcmRes.json()
    
    if (fcmRes.ok) {
        await supabase.from('notifications').update({ delivery_status: 'sent' }).eq('id', record.id)
    } else {
        console.error("FCM Error:", JSON.stringify(result))
        await supabase.from('notifications').update({ delivery_status: 'failed_fcm' }).eq('id', record.id)
    }

    return new Response(JSON.stringify(result), { status: 200 })
  } catch (err) {
    console.error("Function Crash:", err.message)
    return new Response(err.message, { status: 500 })
  }
})