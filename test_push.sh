curl -X POST "https://hhwzbmwtszugjjtovxkz.supabase.co/functions/v1/send-push"   -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhod3pibXd0c3p1Z2pqdG92eGt6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2ODExOTk1MywiZXhwIjoyMDgzNjk1OTUzfQ.iaJdY97sKoN50BcK0HL365ti_TGQ914pHpndXq_KgLg"   -H "Content-Type: application/json"   -d '{
    "record": {
      "id": "test-uuid",
      "recipient_profile_id": "f9072f3e-b66a-4561-94fa-9a055ee1533e",
      "title": "Terminal Test",
      "body": "Direct hit bypass",
      "type": "nudge",
      "payload": {}
    }
  }'
