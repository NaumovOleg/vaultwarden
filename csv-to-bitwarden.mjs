#!/usr/bin/env node
// Convert a CSV with columns
//   type,name,url,autofillUrls,email,username,password,note,totp,createTime,modifyTime,vault
// to the Bitwarden import CSV format
//   folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
// Usage: node csv-to-bitwarden.mjs in.csv > out.csv

import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const OUT_HEADER =
  'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function esc(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function typeToBitwarden(t) {
  const m = {
    login: 'login',
    card: 'card',
    identity: 'identity',
    'secure note': 'secure note',
    note: 'secure note',
  };
  return m[String(t).toLowerCase()] ?? 'login';
}

function convert(input) {
  const rows = parseCsv(input);
  const header = rows.shift().map((h) => h.trim());
  const out = [OUT_HEADER];
  for (const row of rows) {
    const r = Object.fromEntries(header.map((h, i) => [h, row[i] ?? '']));
    const fields = [];
    if (r.email) fields.push(`Email:${r.email}`);
    const notes = [r.note, r.autofillUrls ? `Autofill URLs: ${r.autofillUrls}` : '']
      .filter(Boolean)
      .join('\n');
    out.push(
      [
        r.vault || '',
        '',
        typeToBitwarden(r.type),
        r.name,
        notes,
        fields.join(','),
        '',
        r.url,
        r.username,
        r.password,
        r.totp,
      ]
        .map(esc)
        .join(','),
    );
  }
  return out.join('\n') + '\n';
}

const src = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : '';

const demo = `type,name,url,autofillUrls,email,username,password,note,totp,createTime,modifyTime,vault
login,My Site,https://site.com,\\"https://a.com|https://b.com\\",ME@x.com,user,p4ss,my note,TOTP123,2024-01-01,2024-02-01,Personal
note,Secret Note,,,,,,secret text,,2024-01-01,2024-01-02,Notes
card,Visa,...4345,,,,,,card no fields,,2024-01-01,2024-01-02,,`;

const out = convert(src || demo);
process.stdout.write(out);

if (!src) {
  const lines = out.trim().split('\n');
  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[1],
    'Personal,,login,My Site,"my note\nAutofill URLs: https://a.com|https://b.com",Email:ME@x.com,,https://site.com,user,p4ss,TOTP123');
  assert.strictEqual(lines[2], 'Notes,,secure note,Secret Note,secret text,,,,,,');

  if (process.env.SELF_CHECK) {
    console.log('SELF_CHECK_OK');
  }
}