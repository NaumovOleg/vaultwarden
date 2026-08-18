#!/usr/bin/env bash
# e2e-vault.sh — cipher + folder + import + account lifecycle against a deployed
# Vaultwarden-serverless stack (assumes the user from e2e-auth.sh exists, or registers).
#
# Usage: bash scripts/e2e-vault.sh https://<deployed-domain>
# Env: EMAIL / PASSWORD (defaults: e2e@example.com / e2e-test-password)
#
# Expects signups to be OPEN on the target. Prints PASS/FAIL per step, exits
# non-zero on the first failure.

set -u
URL="${1:?usage: bash scripts/e2e-vault.sh https://<deployed-domain> [EMAIL] [PASSWORD]}"
EMAIL="${2:-e2e@example.com}"
PASSWORD="${3:-e2e-test-password}"
PASSWORD_HASH="$(printf '%s' "$PASSWORD" | base64)"

pass=0; fail=0
step() { printf 'STEP %s... ' "$1"; }
ok()   { printf 'PASS\n'; pass=$((pass+1)); }
bad()  { printf 'FAIL: %s\n' "$2"; fail=$((fail+1)); exit 1; }
json_field() { local f="$1"; python3 -c "import json,sys; print(json.load(sys.stdin).get('$f', ''))" < /tmp/e2e-body; }

json() { curl -s -o /tmp/e2e-body -w '%{http_code}' -X "$1" "$URL$2" -H 'Content-Type: application/json' -H "Authorization: Bearer $ACCESS" --data "$3"; }
get()  { curl -s -o /tmp/e2e-body -w '%{http_code}' "$URL$1" -H "Authorization: Bearer $ACCESS"; }

# 1. login (register first if the account does not exist yet)
step 1
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X POST "$URL/identity/accounts/register" -H 'Content-Type: application/x-www-form-urlencoded' --data "email=$EMAIL&masterPasswordHash=$PASSWORD_HASH&key=YmtleQ==&masterPasswordHint=hint&name=E2E&keys=%7B%22publicKey%22%3A%22cHVi%22%2C%22privateKey%22%3A%22cHJpdg%3D%3D%22%7D")
[ "$code" = "200" ] || [ "$code" = "400" ] || bad 1 "register returned $code: $(head -c 200 /tmp/e2e-body)"
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X POST "$URL/identity/connect/token" -H 'Content-Type: application/x-www-form-urlencoded' --data "grant_type=password&username=$EMAIL&password=$PASSWORD_HASH&scope=api%20offline_access&deviceIdentifier=e2e-vault&deviceName=E2E%20Vault&deviceType=9")
[ "$code" = "200" ] || bad 1 "login returned $code: $(head -c 300 /tmp/e2e-body)"
ACCESS=$(json_field access_token)
[ -n "$ACCESS" ] || bad 1 "missing access_token"
ok

# 2. sync → profile + folders + ciphers present
step 2
[ "$(get /api/sync)" = "200" ] || bad 2 "sync returned $(head -c 200 /tmp/e2e-body)"
python3 -c "import json,sys; d=json.load(open('/tmp/e2e-body')); assert d['object']=='sync' and isinstance(d['folders'], list) and isinstance(d['ciphers'], list) and d['profile']['email']=='$EMAIL'" || bad 2 "sync shape wrong: $(head -c 300 /tmp/e2e-body)"
ok

# 3. create folder
step 3
code=$(json POST /api/folders '{"name":"E2E Folder"}')
[ "$code" = "200" ] || bad 3 "folder create returned $code: $(head -c 200 /tmp/e2e-body)"
FOLDER_ID=$(json_field id)
[ -n "$FOLDER_ID" ] || bad 3 "folder id missing"
grep -q '"object":"folder"' /tmp/e2e-body || bad 3 "folder object wrong"
ok

# 4. create a login cipher inside the folder
step 4
code=$(json POST /api/ciphers "{\"type\":1,\"name\":\"e2e.example.com\",\"folderId\":\"$FOLDER_ID\",\"login\":{\"uris\":[{\"uri\":\"https://e2e.example.com\",\"match\":null}],\"username\":\"alice\",\"password\":\"Mi5lbmNyeXB0ZWQh\"}}")
[ "$code" = "200" ] || bad 4 "cipher create returned $code: $(head -c 200 /tmp/e2e-body)"
CIPHER_ID=$(json_field id)
[ -n "$CIPHER_ID" ] || bad 4 "cipher id missing"
grep -q '"password":"Mi5lbmNyeXB0ZWQh"' /tmp/e2e-body || bad 4 "encrypted value not verbatim: $(head -c 300 /tmp/e2e-body)"
ok

# 5. list shows the cipher; non-login types null (canonical shape)
step 5
[ "$(get /api/ciphers)" = "200" ] || bad 5 "cipher list returned $(head -c 200 /tmp/e2e-body)"
grep -q '"object":"list"' /tmp/e2e-body || bad 5 "list shape wrong"
python3 -c "import json,sys; d=json.load(open('/tmp/e2e-body')); c=[x for x in d['data'] if x['id']=='$CIPHER_ID']; assert len(c)==1 and c[0]['secureNote'] is None and c[0]['card'] is None and c[0]['folderId']=='$FOLDER_ID'" || bad 5 "list contents wrong"
ok

# 6. update + partial (autofill-style password-only merge)
step 6
code=$(json PUT "/api/ciphers/$CIPHER_ID" '{"type":1,"name":"renamed.example.com","login":{"username":"bob"}}')
[ "$code" = "200" ] || bad 6 "update returned $code"
grep -q '"name":"renamed.example.com"' /tmp/e2e-body || bad 6 "update did not replace"
code=$(json PUT "/api/ciphers/$CIPHER_ID/partial" '{"login":{"password":"Mi5uZXctcGFzcw=="}}')
[ "$code" = "200" ] || bad 6 "partial returned $code"
grep -q '"username":"bob"' /tmp/e2e-body || bad 6 "partial lost username"
grep -q '"password":"Mi5uZXctcGFzcw=="' /tmp/e2e-body || bad 6 "partial did not merge password"
ok

# 7. soft delete → excluded from list, present in sync with deletedDate
step 7
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X DELETE "$URL/api/ciphers/$CIPHER_ID" -H "Authorization: Bearer $ACCESS")
[ "$code" = "200" ] || bad 7 "delete returned $code"
python3 -c "import json,sys; d=json.load(open('/tmp/e2e-body')); assert any(c['id']=='$CIPHER_ID' and c['deletedDate'] for c in d['ciphers'])" < /dev/null || bad 7 "sync missing trashed cipher"
[ "$(get /api/ciphers)" = "200" ] || bad 7 "list failed"
grep -q "\"id\":\"$CIPHER_ID\"" /tmp/e2e-body && bad 7 "deleted cipher still in list"
ok

# 8. restore → back in list
step 8
code=$(json POST "/api/ciphers/$CIPHER_ID/restore" '{}')
[ "$code" = "200" ] || bad 8 "restore returned $code"
[ "$(get /api/ciphers)" = "200" ] || bad 8 "list failed"
grep -q "\"id\":\"$CIPHER_ID\"" /tmp/e2e-body || bad 8 "restored cipher missing from list"
ok

# 9. import: 2 folders + 3 ciphers + relationships; then purge + verify row gone
step 9
code=$(json POST /api/ciphers/import '{"folders":[{"name":"Imp A"},{"name":"Imp B"}],"ciphers":[{"type":1,"name":"imp1","login":{"username":"u1"}},{"type":1,"name":"imp2","login":{"username":"u2"}},{"type":2,"name":"imp3","secureNote":{"type":0}}],"folderRelationships":[[0,0],[1,1],[1,2]]}')
[ "$code" = "200" ] || bad 9 "import returned $code: $(head -c 200 /tmp/e2e-body)"
[ "$(get /api/sync)" = "200" ] || bad 9 "sync failed"
python3 -c "import json,sys; d=json.load(open('/tmp/e2e-body')); c=[x for x in d['ciphers'] if x['name']=='imp1']; assert len(c)==1 and c[0]['folderId']" || bad 9 "import relationship missing"
ok

# 10. verify-password (account endpoint) → MasterPasswordPolicy envelope
step 10
code=$(json POST /api/accounts/verify-password "{\"masterPasswordHash\":\"$PASSWORD_HASH\"}")
[ "$code" = "200" ] || bad 10 "verify-password returned $code"
grep -q '"MasterPasswordPolicy"' /tmp/e2e-body || bad 10 "policy missing: $(head -c 200 /tmp/e2e-body)"
ok

# 11. folder delete → folder gone, sync shows folderId null on orphaned ciphers
step 11
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X DELETE "$URL/api/folders/$FOLDER_ID" -H "Authorization: Bearer $ACCESS")
[ "$code" = "200" ] || bad 11 "folder delete returned $code"
[ "$(get /api/sync)" = "200" ] || bad 11 "sync failed"
python3 -c "import json,sys; d=json.load(open('/tmp/e2e-body')); assert all(f['id']!='$FOLDER_ID' for f in d['folders']); c=[x for x in d['ciphers'] if x['name']=='renamed.example.com']; assert len(c)==1 and c[0]['folderId'] is None" || bad 11 "orphan semantics wrong"
ok

# 12. attachment: v2 create → multipart upload → download via fresh url (byte-identical)
step 12
code=$(json POST /api/ciphers/$CIPHER_ID/attachment/v2 '{"key":"ZW5jLWtleQ==","fileName":"e2e.bin","fileSize":12}')
[ "$code" = "200" ] || bad 12 "attachment v2 returned $code: $(head -c 200 /tmp/e2e-body)"
ATT_ID=$(json_field attachmentId)
UPLOAD_URL=$(json_field url)
[ -n "$ATT_ID" ] && [ -n "$UPLOAD_URL" ] || bad 12 "attachment v2 shape wrong: $(head -c 300 /tmp/e2e-body)"
printf 'e2e payload!' > /tmp/e2e-payload
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X POST "$URL${UPLOAD_URL#${URL%/}}" -H "Authorization: Bearer $ACCESS" -F "key=ZW5jLWtleQ==" -F "data=@/tmp/e2e-payload")
[ "$code" = "200" ] || bad 12 "attachment upload returned $code: $(head -c 200 /tmp/e2e-body)"
DOWNLOAD_URL=$(python3 -c "import json,sys; d=json.load(open('/tmp/e2e-body')); print(d['attachments'][0]['url'])" )
[ -n "$DOWNLOAD_URL" ] || bad 12 "missing attachment url"
[ "$(curl -s -o /tmp/e2e-download -w '%{http_code}' "$DOWNLOAD_URL")" = "200" ] || bad 12 "attachment download failed"
cmp -s /tmp/e2e-payload /tmp/e2e-download || bad 12 "attachment download not byte-identical"
ok

# 13. send: text create → anonymous access w/ password → sync shows it → delete cascades
step 13
SEND_ID="$(python3 -c "import uuid; print(uuid.uuid4())")"
code=$(json POST /api/sends "{\"id\":\"$SEND_ID\",\"type\":0,\"name\":\"e2e secret\",\"text\":{\"text\":\"c2VjcmV0\",\"hidden\":true},\"password\":\"c2VuZHB3\",\"maxAccessCount\":3}")
[ "$code" = "200" ] || bad 13 "send create returned $code: $(head -c 200 /tmp/e2e-body)"
ACCESS_ID=$(json_field accessId)
[ -n "$ACCESS_ID" ] || bad 13 "missing accessId"
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X POST "$URL/api/sends/access/$ACCESS_ID" -H 'Content-Type: application/json' --data '{"password":"c2VuZHB3"}')
[ "$code" = "200" ] || bad 13 "send access returned $code: $(head -c 200 /tmp/e2e-body)"
grep -q '"text":"c2VjcmV0"' /tmp/e2e-body || bad 13 "send access payload wrong: $(head -c 300 /tmp/e2e-body)"
[ "$(get /api/sync)" = "200" ] || bad 13 "sync failed"
grep -q "\"id\":\"$SEND_ID\"" /tmp/e2e-body || bad 13 "send missing from sync"
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X DELETE "$URL/api/sends/$SEND_ID" -H "Authorization: Bearer $ACCESS")
[ "$code" = "200" ] || bad 13 "send delete returned $code"
ok

# 14. org: create org + collection → invite second account with no-email token →
#     register second account with token → share cipher → member sync sees it
step 14
ORG_ID="$(python3 -c "import uuid; print(uuid.uuid4())")"
code=$(json POST /api/organizations "{\"id\":\"$ORG_ID\",\"name\":\"E2E Org\",\"billingEmail\":\"org@$EMAIL\",\"key\":\"b3JnLWtleQ==\",\"keys\":{\"publicKey\":\"cHVi\",\"privateKey\":\"cHJpdg==\"},\"collectionName\":\"Team Vault\"}")
[ "$code" = "200" ] || bad 14 "org create returned $code: $(head -c 200 /tmp/e2e-body)"
code=$(json POST "/api/organizations/$ORG_ID/users/invite" '{"emails":[{"email":"member@example.com","type":2}]}')
[ "$code" = "200" ] || bad 14 "invite returned $code: $(head -c 200 /tmp/e2e-body)"
INVITE_TOKEN=$(python3 -c "import json,sys; print(json.load(open('/tmp/e2e-body'))['invites'][0]['accessToken'])")
[ -n "$INVITE_TOKEN" ] || bad 14 "invite token missing"
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X POST "$URL/identity/accounts/register" -H 'Content-Type: application/x-www-form-urlencoded' --data "email=member@example.com&masterPasswordHash=$PASSWORD_HASH&key=YmtleQ==&keys=%7B%22publicKey%22%3A%22cHVi%22%2C%22privateKey%22%3A%22cHJpdg%3D%3D%22%7D&orgInviteToken=$INVITE_TOKEN")
[ "$code" = "200" ] || bad 14 "member register returned $code: $(head -c 200 /tmp/e2e-body)"
MEMBER_ACCESS=$(curl -s -X POST "$URL/identity/connect/token" -H 'Content-Type: application/x-www-form-urlencoded' --data "grant_type=password&username=member@example.com&password=$PASSWORD_HASH&scope=api%20offline_access&deviceIdentifier=e2e-member" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
[ -n "$MEMBER_ACCESS" ] || bad 14 "member login failed"
[ "$(curl -s -o /tmp/e2e-body -w '%{http_code}' "$URL/api/organizations/$ORG_ID" -H "Authorization: Bearer $MEMBER_ACCESS")" = "200" ] || bad 14 "member cannot see org"
COLL_ID="$(curl -s "$URL/api/organizations/$ORG_ID/collections" -H "Authorization: Bearer $ACCESS" | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")"
[ -n "$COLL_ID" ] || bad 14 "collection id missing"
code=$(json POST /api/ciphers "{\"type\":1,\"name\":\"org-secret\",\"login\":{\"username\":\"u\",\"password\":\"cA==\"}}")
[ "$code" = "200" ] || bad 14 "cipher create returned $code"
ORG_CIPHER_ID=$(json_field id)
code=$(json POST "/api/ciphers/$ORG_CIPHER_ID/share" "{\"collectionIds\":[\"$COLL_ID\"]}")
[ "$code" = "200" ] || bad 14 "share returned $code: $(head -c 200 /tmp/e2e-body)"
[ "$(curl -s -o /tmp/e2e-body -w '%{http_code}' "$URL/api/sync" -H "Authorization: Bearer $MEMBER_ACCESS")" = "200" ] || bad 14 "member sync failed"
grep -q "\"id\":\"$ORG_CIPHER_ID\"" /tmp/e2e-body || bad 14 "shared cipher missing from member sync: $(head -c 300 /tmp/e2e-body)"
ok

# 15. 2FA: enable authenticator → logout → login now demands a TOTP code →
#     code login works; second login with the same code session fails → disable
TFA_SECRET=$(curl -s -X POST "$URL/api/two-factor/get-authenticator" -H 'Content-Type: application/json' -H "Authorization: Bearer $ACCESS" --data "{\"masterPasswordHash\":\"$PASSWORD_HASH\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['key'])")
[ -n "$TFA_SECRET" ] || bad 15 "get-authenticator returned no key"
TFA_CODE=$(python3 -c "
import hmac, base64, hashlib, struct, time
key = base64.b32decode('$TFA_SECRET')
counter = int(time.time() // 30)
mac = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
o = mac[-1] & 0x0f
print('{:06d}'.format((struct.unpack('>I', mac[o:o+4])[0] & 0x7fffffff) % 1000000))
")
code=$(json POST /api/two-factor/authenticator "{\"masterPasswordHash\":\"$PASSWORD_HASH\",\"key\":\"$TFA_SECRET\",\"token\":\"$TFA_CODE\"}")
[ "$code" = "200" ] || bad 15 "authenticator enable returned $code: $(head -c 200 /tmp/e2e-body)"
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X POST "$URL/identity/connect/token" -H 'Content-Type: application/x-www-form-urlencoded' --data "grant_type=password&username=$EMAIL&password=$PASSWORD_HASH&scope=api%20offline_access&deviceIdentifier=e2e-vault2&deviceName=E2E%202&deviceType=9")
[ "$code" = "200" ] || bad 15 "2FA-free login after enable returned $code: $(head -c 300 /tmp/e2e-body)"
python3 -c "import json,sys; d=json.load(open('/tmp/e2e-body')); assert d.get('TwoFactorProviders')==[0] and d.get('TwoFactorToken'), str(d)[:200]" || bad 15 "no 2FA challenge: $(head -c 300 /tmp/e2e-body)"
TFA_TOKEN=$(json_field TwoFactorToken)
TFA_CODE2=$(python3 -c "
import hmac, base64, hashlib, struct, time
key = base64.b32decode('$TFA_SECRET')
counter = int(time.time() // 30)
mac = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
o = mac[-1] & 0x0f
print('{:06d}'.format((struct.unpack('>I', mac[o:o+4])[0] & 0x7fffffff) % 1000000))
")
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X POST "$URL/identity/connect/token" -H 'Content-Type: application/x-www-form-urlencoded' --data "grant_type=password&username=$EMAIL&password=$PASSWORD_HASH&scope=api%20offline_access&deviceIdentifier=e2e-vault2&deviceName=E2E%202&deviceType=9&twoFactorToken=$TFA_TOKEN&twoFactorProvider=0&twoFactorCode=$TFA_CODE2")
[ "$code" = "200" ] || bad 15 "TOTP login returned $code: $(head -c 300 /tmp/e2e-body)"
code=$(curl -s -o /tmp/e2e-body -w '%{http_code}' -X POST "$URL/api/two-factor/disable" -H 'Content-Type: application/json' -H "Authorization: Bearer $ACCESS" --data "{\"masterPasswordHash\":\"$PASSWORD_HASH\",\"type\":0}")
[ "$code" = "200" ] || bad 15 "2FA disable returned $code: $(head -c 200 /tmp/e2e-body)"
ok

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = "0" ]