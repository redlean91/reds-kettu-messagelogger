(() => {
  const { metro, patcher, plugin } = vendetta;
  const FluxDispatcher = metro.common.FluxDispatcher;
  const MessageStore = metro.findByStoreName("MessageStore");
  const UserStore = metro.findByStoreName("UserStore");
  const storage = plugin.storage;

  const IGNORE_SELF = true;       // don't log your own deletes/edits
  const MAX_DELETED = 500;        // stored deleted messages (oldest pruned)
  const MAX_EDITED = 500;         // stored messages with edit history
  const MAX_EDITS_PER_MSG = 10;
  const MARK = "\n\u2063\n";      // separates real content from edit-history footer
  const DEL = "\u{1F5D1}\uFE0F ";

  const cmp = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0); // snowflakes
  const strip = (s) => { const i = s.indexOf(MARK); return i < 0 ? s : s.slice(0, i); };

  const withHistory = (raw, id) => {
    const e = storage.edits[id];
    if (!e || !e.h.length) return raw;
    return raw + MARK + e.h.map((x) => "> \u270F\uFE0F ~~" + x.c.replace(/\s+/g, " ").slice(0, 200) + "~~").join("\n");
  };

  const prune = (obj, max) => {
    const k = Object.keys(obj);
    if (k.length <= max) return;
    k.sort((a, b) => obj[a].t - obj[b].t).slice(0, k.length - max).forEach((x) => delete obj[x]);
  };

  const snap = (m) => {
    const a = m.author || {};
    const ts = m.timestamp;
    return {
      id: m.id,
      channel_id: m.channelId ?? m.channel_id,
      type: m.type ?? 0,
      content: strip(m.content || ""),
      author: {
        id: a.id, username: a.username, discriminator: a.discriminator ?? "0",
        avatar: a.avatar ?? null, global_name: a.globalName ?? a.global_name ?? null, bot: !!a.bot,
      },
      attachments: (m.attachments || []).map((x) => ({
        id: x.id, filename: x.filename, size: x.size, url: x.url,
        proxy_url: x.proxy_url ?? x.proxyURL ?? x.url, width: x.width, height: x.height,
        content_type: x.content_type ?? x.contentType,
      })),
      embeds: [], mentions: [], mention_roles: [], pinned: false,
      mention_everyone: false, tts: false, flags: 0,
      timestamp: ts && ts.toISOString ? ts.toISOString() : ts,
      edited_timestamp: null,
    };
  };

  const isSelf = (m) => {
    try { return IGNORE_SELF && m?.author?.id === UserStore.getCurrentUser()?.id; } catch { return false; }
  };

  const handle = (ev, orig) => {
    // live delete -> keep message, mark deleted, persist
    if (ev.type === "MESSAGE_DELETE") {
      const m = MessageStore.getMessage(ev.channelId, ev.id);
      if (m && (m.type === 0 || m.type === 19) && !isSelf(m) && !storage.deleted[ev.id]) {
        const s = snap(m);
        storage.deleted[ev.id] = { t: Date.now(), m: s };
        prune(storage.deleted, MAX_DELETED);
        return orig({ type: "MESSAGE_UPDATE", guildId: ev.guildId, message: { ...s, content: DEL + s.content } });
      }
      if (storage.deleted[ev.id]) return; // already kept
    }

    // live edit -> record previous content, persist, show history
    if (ev.type === "MESSAGE_UPDATE" && ev.message && typeof ev.message.content === "string" && ev.message.edited_timestamp) {
      const nm = ev.message;
      if (storage.deleted[nm.id]) return orig(ev);
      const old = MessageStore.getMessage(nm.channel_id, nm.id);
      if (old && !isSelf(old)) {
        const oldRaw = strip(old.content || "");
        if (oldRaw !== nm.content) {
          const e = storage.edits[nm.id] || { t: 0, h: [] };
          const h = [...e.h, { c: oldRaw, t: Date.now() }].slice(-MAX_EDITS_PER_MSG);
          storage.edits[nm.id] = { t: Date.now(), h };
          prune(storage.edits, MAX_EDITED);
        }
        return orig({ ...ev, message: { ...nm, content: withHistory(nm.content, nm.id) } });
      }
    }

    // channel load -> re-apply history + re-inject stored deleted messages
    if (ev.type === "LOAD_MESSAGES_SUCCESS" && Array.isArray(ev.messages) && ev.messages.length) {
      const have = new Set(ev.messages.map((m) => m.id));
      const msgs = ev.messages.map((m) => (storage.edits[m.id] ? { ...m, content: withHistory(m.content, m.id) } : m));
      let newest = ev.messages[0].id, oldest = newest;
      for (const m of ev.messages) { if (cmp(m.id, newest) > 0) newest = m.id; if (cmp(m.id, oldest) < 0) oldest = m.id; }
      const newerOk = !ev.isBefore && !ev.hasMoreAfter;
      const olderOk = !ev.isAfter && !ev.hasMoreBefore;
      const extra = Object.values(storage.deleted)
        .filter((d) => d.m.channel_id === ev.channelId && !have.has(d.m.id) &&
          (cmp(d.m.id, newest) > 0 ? newerOk : cmp(d.m.id, oldest) < 0 ? olderOk : true))
        .map((d) => ({ ...d.m, content: DEL + d.m.content }));
      if (extra.length || msgs.some((m, i) => m !== ev.messages[i])) {
        return orig({ ...ev, messages: [...msgs, ...extra].sort((a, b) => cmp(b.id, a.id)) });
      }
    }
    return orig(ev);
  };

  let unpatch;
  return {
    onLoad() {
      storage.deleted ??= {};
      storage.edits ??= {};
      unpatch = patcher.instead("dispatch", FluxDispatcher, (args, orig) => {
        try { return handle(args[0], orig); } catch (e) { return orig(...args); }
      });
    },
    onUnload() { unpatch?.(); },
  };
})()
