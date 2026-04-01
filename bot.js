require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const supabase = require("./utils/supabase");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// ─── Admins ───────────────────────────────────────────────────────────────────
// В .env можно указать несколько ID через запятую:
// ADMIN_TELEGRAM_CHAT_ID=123456,789012,345678
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

const isAdmin = (userId) => ADMIN_IDS.includes(String(userId));

// ─── Deadline ─────────────────────────────────────────────────────────────────
// В .env укажите: REGISTRATION_DEADLINE=2026-04-03T18:00:00
// Формат: ISO 8601 (по ташкентскому времени UTC+5)
const DEADLINE_RAW = process.env.REGISTRATION_DEADLINE || null;
const DEADLINE = DEADLINE_RAW ? new Date(DEADLINE_RAW) : null;

function isDeadlinePassed() {
    if (!DEADLINE) return false;
    return new Date() > DEADLINE;
}

function formatDeadline() {
    if (!DEADLINE) return null;
    return DEADLINE.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Tashkent"
    });
}

// ─── In-memory state ──────────────────────────────────────────────────────────
// { [telegramId]: { step, branch, firstName, lastName } }
const userState = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const removeKeyboard = { reply_markup: { remove_keyboard: true } };

async function notifyAdmins(message) {
    for (const adminId of ADMIN_IDS) {
        try {
            await bot.sendMessage(adminId, message, { parse_mode: "HTML" });
        } catch (e) {
            console.error(`Failed to notify admin ${adminId}:`, e.message);
        }
    }
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    bot.sendMessage(
        chatId,
        `🔥 <b>Frontend Battle – Filialda Kod Ustasi Sinovi!</b> 🔥\n\nZerikdingizmi? 💻 Keling, filialni jonlantiramiz!\nFrontend dasturlash bo\'yicha front-battle boshlanadi!\n\n✅ Kim eng tez kod yozadi?\n✅ Kim eng kreativ dizayn yaratadi?\n✅ Kim chempion bo\'ladi? 🏆\n\nDo\'stlaringni tag qil, o\'z mahoratingni sinab ko\'r va filialni jonlantirishga yordam ber!` +
        (formatDeadline() ? `\n\n⏳ <b>Ro'yxatdan o'tish muddati:</b> ${formatDeadline()} gacha` : ""),
        {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[{ text: "✅ Qo'shilish", callback_data: "join" }]]
            }
        }
    );
});

// ─── /admin ───────────────────────────────────────────────────────────────────
bot.onText(/\/admin/, async (msg) => {
    if (!isAdmin(msg.from.id)) {
        return bot.sendMessage(msg.chat.id, "❌ Sizda admin huquqi yo'q.");
    }
    await sendAdminPanel(msg.chat.id);
});

// ─── Admin panel sender ───────────────────────────────────────────────────────
async function sendAdminPanel(chatId, branchFilter = null) {
    let query = supabase.from("users").select("*").order("created_at", { ascending: false });

    if (branchFilter) {
        query = query.eq("branch", branchFilter);
    }

    const { data: users, error } = await query;

    if (error) {
        console.error("Admin fetch error:", error);
        return bot.sendMessage(chatId, "❌ Ma'lumotlarni olishda xatolik.");
    }

    if (!users || users.length === 0) {
        return bot.sendMessage(chatId, "📭 Hali hech kim ro'yxatdan o'tmagan.");
    }

    // --- Stats header ---
    const total = users.length;
    const filled = users.filter((u) => u.status === "filled").length;

    const byBranch = users.reduce((acc, u) => {
        const b = u.branch || "Noma'lum";
        acc[b] = (acc[b] || 0) + 1;
        return acc;
    }, {});

    const branchStats = Object.entries(byBranch)
        .map(([b, count]) => `  • ${b}: <b>${count}</b> ta`)
        .join("\n");

    const header =
        `📊 <b>Battle ishtirokchilari</b>${branchFilter ? ` — ${branchFilter}` : ""}\n\n` +
        `👥 Jami: <b>${total}</b>\n` +
        `✅ To'ldirilgan: <b>${filled}</b>\n\n` +
        `🏢 Filiallar:\n${branchStats}\n` +
        (formatDeadline() ? `\n⏳ Muddat: <b>${formatDeadline()}</b>${isDeadlinePassed() ? " — <b>TUGADI</b>" : ""}\n` : "") +
        `\n${"─".repeat(28)}\n\n`;

    // --- Split into chunks (Telegram 4096 char limit) ---
    const chunks = [];
    let current = header;

    for (const u of users) {
        const statusEmoji = u.status === "filled" ? "✅" : "⏳";
        const entry =
            `${statusEmoji} <b>${u.name || "Ism yo'q"}</b>\n` +
            `   🏢 ${u.branch || "—"}\n` +
            `   📱 ${u.phone || "—"}\n` +
            `   🆔 @${u.telegram_username || "—"} (<code>${u.telegram_id}</code>)\n` +
            `   📅 ${new Date(u.created_at).toLocaleString("ru-RU")}\n\n`;

        if ((current + entry).length > 3800) {
            chunks.push(current);
            current = entry;
        } else {
            current += entry;
        }
    }

    if (current.trim()) chunks.push(current);

    for (const chunk of chunks) {
        await bot.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    }

    // Filter buttons
    await bot.sendMessage(chatId, "🔍 Filtr:", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🏢 Minor", callback_data: "admin_filter_Minor" },
                    { text: "🏢 Oybek", callback_data: "admin_filter_Oybek" }
                ],
                [{ text: "📋 Barchasi", callback_data: "admin_filter_all" }]
            ]
        }
    });
}

// ─── Callback queries ─────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const username = query.from.username || null;
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    // ── Admin filters ──────────────────────────────────────────────────────────
    if (data.startsWith("admin_filter_")) {
        if (!isAdmin(userId)) return;

        const filter = data.replace("admin_filter_", "");
        await sendAdminPanel(chatId, filter === "all" ? null : filter);
        return;
    }

    // ── join ───────────────────────────────────────────────────────────────────
    if (data === "join") {
        if (isDeadlinePassed()) {
            return bot.sendMessage(
                chatId,
                `⛔ <b>Ro'yxatdan o'tish muddati tugadi.</b>\n\n⏳ Muddat: ${formatDeadline()} gacha edi.`,
                { parse_mode: "HTML" }
            );
        }

        const { data: existing, error } = await supabase
            .from("users")
            .select("id, status")
            .eq("telegram_id", userId)
            .maybeSingle();

        if (error) {
            console.error("Fetch error:", error);
            return bot.sendMessage(chatId, "❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
        }

        if (existing?.status === "filled") {
            return bot.sendMessage(chatId, "✅ Siz allaqachon ro'yxatdan o'tgansiz!");
        }

        if (!existing) {
            const { error: insertError } = await supabase
                .from("users")
                .insert([{
                    telegram_id: userId,
                    telegram_username: username,
                    status: "not_filled"
                }]);

            if (insertError) {
                console.error("Insert error:", insertError);
                return bot.sendMessage(chatId, "❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
            }
        }

        userState[userId] = { step: "awaiting_branch" };

        return bot.sendMessage(chatId, "📍 Filialingizni tanlang:", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🏢 Minor", callback_data: "branch_Minor" }],
                    [{ text: "🏢 Oybek", callback_data: "branch_Oybek" }]
                ]
            }
        });
    }

    // ── branch selection ───────────────────────────────────────────────────────
    if (data === "branch_Minor" || data === "branch_Oybek") {
        const branchName = data === "branch_Minor" ? "Minor" : "Oybek";

        const { error } = await supabase
            .from("users")
            .update({ branch: branchName })
            .eq("telegram_id", userId);

        if (error) {
            console.error("Branch update error:", error);
            return bot.sendMessage(chatId, "❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
        }

        userState[userId] = { step: "awaiting_first_name", branch: branchName };

        return bot.sendMessage(chatId, "👤 Ismingizni kiriting:", removeKeyboard);
    }
});

// ─── Text & Contact messages ──────────────────────────────────────────────────
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const state = userState[userId];

    // ── Phone contact ──────────────────────────────────────────────────────────
    if (msg.contact) {
        if (!state || state.step !== "awaiting_phone") return;

        const phone = msg.contact.phone_number;
        const fullName = `${state.firstName} ${state.lastName}`.trim();

        const { error } = await supabase
            .from("users")
            .update({ phone, name: fullName, status: "filled" })
            .eq("telegram_id", userId);

        if (error) {
            console.error("Final update error:", error);
            return bot.sendMessage(chatId, "❌ Xatolik yuz berdi.", removeKeyboard);
        }

        delete userState[userId];

        await bot.sendMessage(
            chatId,
            `🎉 <b>Tabriklaymiz!</b>\n\nSiz muvaffaqiyatli ro'yxatdan o'tdingiz!\n\n` +
            `👤 Ism: <b>${fullName}</b>\n` +
            `🏢 Filial: <b>${state.branch}</b>\n` +
            `📱 Telefon: <b>${phone}</b>\n\n` +
            `🔥 Battle boshlanishini kuting!`,
            { parse_mode: "HTML", ...removeKeyboard }
        );

        // Notify all admins
        await notifyAdmins(
            `🆕 <b>Yangi ishtirokchi qo'shildi!</b>\n\n` +
            `👤 Ism: <b>${fullName}</b>\n` +
            `🏢 Filial: <b>${state.branch}</b>\n` +
            `📱 Telefon: <b>${phone}</b>\n` +
            `🆔 @${msg.from.username || "—"} (<code>${userId}</code>)`
        );

        return;
    }

    // ── Text only ──────────────────────────────────────────────────────────────
    if (!msg.text || msg.text.startsWith("/") || !state) return;

    // Step 1: First name
    if (state.step === "awaiting_first_name") {
        const firstName = msg.text.trim();

        if (firstName.length < 2) {
            return bot.sendMessage(chatId, "⚠️ Iltimos, to'g'ri ism kiriting (kamida 2 ta harf).");
        }

        userState[userId] = { ...state, step: "awaiting_last_name", firstName };
        return bot.sendMessage(chatId, "👤 Familiyangizni kiriting:");
    }

    // Step 2: Last name
    if (state.step === "awaiting_last_name") {
        const lastName = msg.text.trim();

        if (lastName.length < 2) {
            return bot.sendMessage(chatId, "⚠️ Iltimos, to'g'ri familiya kiriting (kamida 2 ta harf).");
        }

        userState[userId] = { ...state, step: "awaiting_phone", lastName };

        return bot.sendMessage(chatId, "📱 Telefon raqamingizni yuboring:", {
            reply_markup: {
                keyboard: [[{ text: "📱 Raqamni yuborish", request_contact: true }]],
                resize_keyboard: true,
                one_time_keyboard: true
            }
        });
    }
});

console.log("🤖 Bot ishga tushdi...");