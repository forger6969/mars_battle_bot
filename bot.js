require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const supabase = require("./utils/supabase");
const express = require("express");
const app = express();

app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
bot.setWebHook(`${process.env.BACKEND_URL}/bot${process.env.TELEGRAM_BOT_TOKEN}`);

app.post(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, (req, res) => {
    console.log("update", req.body);
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Bot is running"));
app.listen(process.env.PORT || 3000, () => console.log("Server running"));

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_CHAT_ID || "")
    .split(",").map((id) => id.trim()).filter(Boolean);

const isAdmin = (userId) => ADMIN_IDS.includes(String(userId));

const DEADLINE_RAW = process.env.REGISTRATION_DEADLINE || null;
const DEADLINE = DEADLINE_RAW ? new Date(DEADLINE_RAW) : null;

function isDeadlinePassed() {
    if (!DEADLINE) return false;
    return new Date() > DEADLINE;
}

function formatDeadline() {
    if (!DEADLINE) return null;
    return DEADLINE.toLocaleString("ru-RU", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tashkent"
    });
}

const userState = {};
const removeKeyboard = { reply_markup: { remove_keyboard: true } };

// ─── ADMIN NOTIFY ─────────────────────────────────────────────────────────────

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
    if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "❌ Sizda admin huquqi yo'q.");
    await sendAdminPanel(msg.chat.id);
});

// ─── /survey — рассылка опроса всем пользователям ────────────────────────────
//
//  Использование:
//    /survey Qaysi stack bilan ishlaysiz?
//    /survey HTML/CSS bilim darajangiz qanday?
//
//  Можно передать любой вопрос после команды. Если вопрос не указан,
//  бот попросит ввести его в следующем сообщении.

bot.onText(/\/survey([\s\S]*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isAdmin(userId)) return bot.sendMessage(chatId, "❌ Sizda admin huquqi yo'q.");

    const questionArg = (match[1] || "").trim();

    if (!questionArg) {
        // Ожидаем вопрос в следующем сообщении
        userState[userId] = { step: "admin_awaiting_survey_question" };
        return bot.sendMessage(chatId, "✏️ Opros savolini yozing:\n\n(Bekor qilish uchun /cancel)", removeKeyboard);
    }

    await startSurvey(chatId, questionArg);
});

// ─── /responses — просмотр ответов на последний опрос ─────────────────────────

bot.onText(/\/responses/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, "❌ Sizda admin huquqi yo'q.");
    await sendSurveyResponses(chatId);
});

// ─── /cancel ──────────────────────────────────────────────────────────────────

bot.onText(/\/cancel/, (msg) => {
    const userId = msg.from.id;
    if (userState[userId]) {
        delete userState[userId];
        return bot.sendMessage(msg.chat.id, "❌ Bekor qilindi.", removeKeyboard);
    }
});

// ─── SURVEY LOGIC ─────────────────────────────────────────────────────────────

async function startSurvey(adminChatId, question) {
    // Сохраняем вопрос в таблицу surveys
    const { data: survey, error: surveyError } = await supabase
        .from("surveys")
        .insert([{ question, created_at: new Date().toISOString() }])
        .select()
        .single();

    if (surveyError) {
        console.error("Survey insert error:", surveyError);
        return bot.sendMessage(adminChatId, "❌ Opros yaratishda xatolik yuz berdi.");
    }

    const surveyId = survey.id;

    // Берём всех зарегистрированных пользователей
    const { data: users, error } = await supabase
        .from("users")
        .select("telegram_id, name")
        .eq("status", "filled");

    if (error || !users?.length) {
        return bot.sendMessage(adminChatId, "📭 Hali hech kim ro'yxatdan o'tmagan.");
    }

    let sent = 0, failed = 0;

    await bot.sendMessage(adminChatId, `📤 Opros yuborilmoqda... (${users.length} ta foydalanuvchi)`);

    for (const user of users) {
        try {
            await bot.sendMessage(
                user.telegram_id,
                `📋 <b>Sizga savol!</b>\n\n❓ ${question}\n\n✍️ Javobingizni yozing:`,
                { parse_mode: "HTML", ...removeKeyboard }
            );

            // Ставим пользователя в режим ожидания ответа
            userState[user.telegram_id] = {
                step: "awaiting_survey_answer",
                surveyId,
                question
            };

            sent++;
            // Небольшая задержка чтобы не словить flood limit
            await new Promise((r) => setTimeout(r, 50));
        } catch (e) {
            console.error(`Cannot send to ${user.telegram_id}:`, e.message);
            failed++;
        }
    }

    await bot.sendMessage(
        adminChatId,
        `✅ Opros yuborildi!\n\n📤 Yuborildi: <b>${sent}</b>\n❌ Yuborilmadi: <b>${failed}</b>\n\n🆔 Opros ID: <code>${surveyId}</code>\n\nJavoblarni ko'rish uchun: /responses`,
        { parse_mode: "HTML" }
    );
}

async function sendSurveyResponses(chatId) {
    // Последний опрос
    const { data: survey, error: sErr } = await supabase
        .from("surveys")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

    if (sErr || !survey) {
        return bot.sendMessage(chatId, "📭 Hali hech qanday opros o'tkazilmagan.");
    }

    const { data: responses, error: rErr } = await supabase
        .from("survey_responses")
        .select("*, users(name, branch, telegram_username)")
        .eq("survey_id", survey.id)
        .order("created_at", { ascending: false });

    if (rErr) {
        console.error("Responses fetch error:", rErr);
        return bot.sendMessage(chatId, "❌ Javoblarni olishda xatolik.");
    }

    const total_sent = (await supabase
        .from("users")
        .select("id", { count: "exact" })
        .eq("status", "filled")).count || "?";

    const answered = responses?.length || 0;

    let text =
        `📊 <b>Opros natijalari</b>\n\n` +
        `❓ <b>Savol:</b> ${survey.question}\n` +
        `📅 <b>Sana:</b> ${new Date(survey.created_at).toLocaleString("ru-RU")}\n` +
        `👥 <b>Javob berdi:</b> ${answered} / ${total_sent}\n\n` +
        `${"─".repeat(28)}\n\n`;

    if (!answered) {
        text += "⏳ Hali hech kim javob bermadi.";
        return bot.sendMessage(chatId, text, { parse_mode: "HTML" });
    }

    const chunks = [];
    let current = text;

    for (const r of responses) {
        const u = r.users;
        const entry =
            `👤 <b>${u?.name || "Noma'lum"}</b> ${u?.branch ? `(${u.branch})` : ""}\n` +
            `   @${u?.telegram_username || "—"}\n` +
            `   💬 ${r.answer}\n` +
            `   📅 ${new Date(r.created_at).toLocaleString("ru-RU")}\n\n`;

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
}

// ─── ADMIN PANEL ──────────────────────────────────────────────────────────────

async function sendAdminPanel(chatId, branchFilter = null) {
    let query = supabase.from("users").select("*").order("created_at", { ascending: false });
    if (branchFilter) query = query.eq("branch", branchFilter);

    const { data: users, error } = await query;

    if (error) {
        console.error("Admin fetch error:", error);
        return bot.sendMessage(chatId, "❌ Ma'lumotlarni olishda xatolik.");
    }

    if (!users || users.length === 0) {
        return bot.sendMessage(chatId, "📭 Hali hech kim ro'yxatdan o'tmagan.");
    }

    const total = users.length;
    const filled = users.filter((u) => u.status === "filled").length;

    const byBranch = users.reduce((acc, u) => {
        const b = u.branch || "Noma'lum";
        acc[b] = (acc[b] || 0) + 1;
        return acc;
    }, {});

    const branchStats = Object.entries(byBranch)
        .map(([b, count]) => `  • ${b}: <b>${count}</b> ta`).join("\n");

    const header =
        `📊 <b>Battle ishtirokchilari</b>${branchFilter ? ` — ${branchFilter}` : ""}\n\n` +
        `👥 Jami: <b>${total}</b>\n` +
        `✅ To'ldirilgan: <b>${filled}</b>\n\n` +
        `🏢 Filiallar:\n${branchStats}\n` +
        (formatDeadline() ? `\n⏳ Muddat: <b>${formatDeadline()}</b>${isDeadlinePassed() ? " — <b>TUGADI</b>" : ""}\n` : "") +
        `\n${"─".repeat(28)}\n\n`;

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
    for (const chunk of chunks) await bot.sendMessage(chatId, chunk, { parse_mode: "HTML" });

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

// ─── CALLBACK QUERY ───────────────────────────────────────────────────────────

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const username = query.from.username || null;
    const data = query.data;

    await bot.answerCallbackQuery(query.id);

    if (data.startsWith("admin_filter_")) {
        if (!isAdmin(userId)) return;
        const filter = data.replace("admin_filter_", "");
        await sendAdminPanel(chatId, filter === "all" ? null : filter);
        return;
    }

    if (data === "join") {
        if (isDeadlinePassed()) {
            return bot.sendMessage(chatId,
                `⛔ <b>Ro'yxatdan o'tish muddati tugadi.</b>\n\n⏳ Muddat: ${formatDeadline()} gacha edi.`,
                { parse_mode: "HTML" });
        }

        const { data: existing, error } = await supabase
            .from("users").select("id, status").eq("telegram_id", userId).maybeSingle();

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
                .insert([{ telegram_id: userId, telegram_username: username, status: "not_filled" }]);

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

    if (data === "branch_Minor" || data === "branch_Oybek") {
        const branchName = data === "branch_Minor" ? "Minor" : "Oybek";

        const { error } = await supabase
            .from("users").update({ branch: branchName }).eq("telegram_id", userId);

        if (error) {
            console.error("Branch update error:", error);
            return bot.sendMessage(chatId, "❌ Xatolik yuz berdi. Qayta urinib ko'ring.");
        }

        userState[userId] = { step: "awaiting_first_name", branch: branchName };
        return bot.sendMessage(chatId, "👤 Ismingizni kiriting:", removeKeyboard);
    }
});

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const state = userState[userId];

    // ── Контакт (телефон) ──────────────────────────────────────────────────────
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

        await bot.sendMessage(chatId,
            `🎉 <b>Tabriklaymiz!</b>\n\nSiz muvaffaqiyatli ro'yxatdan o'tdingiz!\n\n` +
            `👤 Ism: <b>${fullName}</b>\n` +
            `🏢 Filial: <b>${state.branch}</b>\n` +
            `📱 Telefon: <b>${phone}</b>\n\n` +
            `🔥 Battle boshlanishini kuting!`,
            { parse_mode: "HTML", ...removeKeyboard }
        );

        await notifyAdmins(
            `🆕 <b>Yangi ishtirokchi qo'shildi!</b>\n\n` +
            `👤 Ism: <b>${fullName}</b>\n` +
            `🏢 Filial: <b>${state.branch}</b>\n` +
            `📱 Telefon: <b>${phone}</b>\n` +
            `🆔 @${msg.from.username || "—"} (<code>${userId}</code>)`
        );
        return;
    }

    if (!msg.text || msg.text.startsWith("/") || !state) return;

    // ── Админ вводит вопрос для опроса ────────────────────────────────────────
    if (state.step === "admin_awaiting_survey_question") {
        delete userState[userId];
        await startSurvey(chatId, msg.text.trim());
        return;
    }

    // ── Пользователь отвечает на опрос ────────────────────────────────────────
    if (state.step === "awaiting_survey_answer") {
        const answer = msg.text.trim();

        const { error } = await supabase
            .from("survey_responses")
            .insert([{
                survey_id: state.surveyId,
                telegram_id: userId,
                answer,
                created_at: new Date().toISOString()
            }]);

        if (error) {
            // Если уже ответил — дубликат
            if (error.code === "23505") {
                return bot.sendMessage(chatId, "ℹ️ Siz ushbu oprosgа allaqachon javob bergansiz.");
            }
            console.error("Survey response insert error:", error);
            return bot.sendMessage(chatId, "❌ Javobni saqlashda xatolik.", removeKeyboard);
        }

        delete userState[userId];

        await bot.sendMessage(chatId,
            `✅ <b>Javobingiz qabul qilindi!</b>\n\n💬 "${answer}"\n\nRahmat! 🙏`,
            { parse_mode: "HTML", ...removeKeyboard }
        );

        // Уведомляем всех админов о новом ответе
        const { data: user } = await supabase
            .from("users").select("name, branch").eq("telegram_id", userId).single();

        await notifyAdmins(
            `💬 <b>Yangi javob!</b>\n\n` +
            `👤 ${user?.name || "Noma'lum"} (${user?.branch || "—"})\n` +
            `❓ ${state.question}\n` +
            `💬 <b>${answer}</b>`
        );
        return;
    }

    // ── Регистрация: имя ───────────────────────────────────────────────────────
    if (state.step === "awaiting_first_name") {
        const firstName = msg.text.trim();
        if (firstName.length < 2)
            return bot.sendMessage(chatId, "⚠️ Iltimos, to'g'ri ism kiriting (kamida 2 ta harf).");
        userState[userId] = { ...state, step: "awaiting_last_name", firstName };
        return bot.sendMessage(chatId, "👤 Familiyangizni kiriting:");
    }

    // ── Регистрация: фамилия ───────────────────────────────────────────────────
    if (state.step === "awaiting_last_name") {
        const lastName = msg.text.trim();
        if (lastName.length < 2)
            return bot.sendMessage(chatId, "⚠️ Iltimos, to'g'ri familiya kiriting (kamida 2 ta harf).");
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