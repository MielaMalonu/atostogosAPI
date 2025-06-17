// index.js
require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const { Client, GatewayIntentBits, Partials, PermissionsBitField } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const moment = require('moment-timezone'); // For easier date/time handling and timezone support

const app = express();
app.use(express.json()); // Enable JSON body parsing for Express

// --- Environment Variables ---
const PORT = process.env.PORT || 3000;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID; // The ID of your Discord server/guild
const DISCORD_HOLIDAY_ROLE_ID = process.env.DISCORD_HOLIDAY_ROLE_ID; // The ID of the role to add/remove
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Vilnius'; // Default to Lithuania's timezone (EEST)

// --- Supabase Client Initialization ---
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
console.log('Supabase Client Initialized.');

// --- Discord Client Initialization ---
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers, // Required to fetch members and manage roles
        GatewayIntentBits.DirectMessages, // Required to send DMs
    ],
    partials: [Partials.Channel], // Required for DMs to work properly
});

discordClient.once('ready', () => {
    console.log(`Discord Bot Logged in as ${discordClient.user.tag}!`);
});

discordClient.login(DISCORD_BOT_TOKEN)
    .catch(error => {
        console.error('Failed to log in to Discord:', error);
        process.exit(1); // Exit if Discord login fails
    });

// --- Helper Functions ---

/**
 * Adds a specified role to a Discord user.
 * @param {string} userId - The Discord user ID.
 * @returns {Promise<boolean>} - True if role was added, false otherwise.
 */
async function addHolidayRole(userId) {
    try {
        const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
        const member = await guild.members.fetch(userId);

        if (!member) {
            console.warn(`User ${userId} not found in guild.`);
            return false;
        }

        const role = guild.roles.cache.get(DISCORD_HOLIDAY_ROLE_ID);
        if (!role) {
            console.error(`Role with ID ${DISCORD_HOLIDAY_ROLE_ID} not found in guild.`);
            return false;
        }

        if (member.roles.cache.has(DISCORD_HOLIDAY_ROLE_ID)) {
            console.log(`User ${userId} already has the holiday role.`);
            return true; // Role already exists, consider it a success
        }

        // Check if the bot has permissions to manage roles
        if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            console.error('Bot does not have permissions to manage roles!');
            return false;
        }
        // Check if the bot's role is higher than the role it's trying to assign
        if (guild.members.me.roles.highest.position <= role.position) {
            console.error(`Bot's highest role is not higher than the role it's trying to assign (${role.name}).`);
            return false;
        }


        await member.roles.add(role);
        console.log(`Added holiday role to user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Error adding holiday role to user ${userId}:`, error);
        return false;
    }
}

/**
 * Removes a specified role from a Discord user.
 * @param {string} userId - The Discord user ID.
 * @returns {Promise<boolean>} - True if role was removed, false otherwise.
 */
async function removeHolidayRole(userId) {
    try {
        const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
        const member = await guild.members.fetch(userId);

        if (!member) {
            console.warn(`User ${userId} not found in guild.`);
            return false;
        }

        const role = guild.roles.cache.get(DISCORD_HOLIDAY_ROLE_ID);
        if (!role) {
            console.error(`Role with ID ${DISCORD_HOLIDAY_ROLE_ID} not found in guild.`);
            return false;
        }

        if (!member.roles.cache.has(DISCORD_HOLIDAY_ROLE_ID)) {
            console.log(`User ${userId} does not have the holiday role.`);
            return true; // Role not present, consider it a success
        }

        // Check if the bot has permissions to manage roles
        if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            console.error('Bot does not have permissions to manage roles!');
            return false;
        }
        // Check if the bot's role is higher than the role it's trying to remove
        if (guild.members.me.roles.highest.position <= role.position) {
            console.error(`Bot's highest role is not higher than the role it's trying to remove (${role.name}).`);
            return false;
        }


        await member.roles.remove(role);
        console.log(`Removed holiday role from user ${userId}`);
        return true;
    } catch (error) {
        console.error(`Error removing holiday role from user ${userId}:`, error);
        return false;
    }
}

/**
 * Sends a direct message to a Discord user.
 * @param {string} userId - The Discord user ID.
 * @param {string} message - The message content.
 * @returns {Promise<boolean>} - True if DM was sent, false otherwise.
 */
async function sendDirectMessage(userId, message) {
    try {
        const user = await discordClient.users.fetch(userId);
        if (user) {
            await user.send(message);
            console.log(`Sent DM to user ${userId}: "${message}"`);
            return true;
        } else {
            console.warn(`Could not find Discord user with ID: ${userId}`);
            return false;
        }
    } catch (error) {
        console.error(`Error sending DM to user ${userId}:`, error);
        return false;
    }
}

// --- API Endpoint to Schedule Holiday ---
app.post('/schedule-holiday', async (req, res) => {
    const { discordUserId, reason, startDate, endDate } = req.body;

    if (!discordUserId || !reason || !startDate || !endDate) {
        return res.status(400).json({ error: 'Missing required fields: discordUserId, reason, startDate, endDate' });
    }

    const startMoment = moment.tz(startDate, 'YYYY/MM/DD HH:mm', TIMEZONE);
    const endMoment = moment.tz(endDate, 'YYYY/MM/DD HH:mm', TIMEZONE);

    if (!startMoment.isValid() || !endMoment.isValid()) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY/MM/DD HH:mm.' });
    }
    if (endMoment.isSameOrBefore(startMoment)) {
        return res.status(400).json({ error: 'End date must be after start date.' });
    }

    try {
        const { data, error } = await supabase
            .from('holidays')
            .insert({
                discord_user_id: discordUserId,
                reason: reason,
                start_time: startMoment.toISOString(), // Store as ISO string (UTC)
                end_time: endMoment.toISOString(),     // Store as ISO string (UTC)
                status: 'pending',
            });

        if (error) {
            console.error('Supabase insert error:', error);
            return res.status(500).json({ error: 'Failed to save holiday to database.' });
        }

        res.status(200).json({ message: 'Holiday scheduled successfully!', holiday: data[0] });
    } catch (error) {
        console.error('Error scheduling holiday:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- Scheduled Cron Jobs ---

// Cron job to check for holidays that need to start
// Runs every minute to check for upcoming holidays
cron.schedule('* * * * *', async () => {
    console.log(`[Scheduler] Checking for holidays to start at ${moment().tz(TIMEZONE).format('YYYY-MM-DD HH:mm:ss')}`);
    try {
        const now = moment().tz(TIMEZONE);
        const { data: holidays, error } = await supabase
            .from('holidays')
            .select('*')
            .eq('status', 'pending')
            .lt('start_time', now.toISOString()); // Select holidays that should have started by now

        if (error) {
            console.error('Supabase fetch error for starting holidays:', error);
            return;
        }

        for (const holiday of holidays) {
            console.log(`[Scheduler] Starting holiday for user ${holiday.discord_user_id} (Reason: ${holiday.reason})`);

            // Perform Discord actions
            const roleAdded = await addHolidayRole(holiday.discord_user_id);
            const dmSent = await sendDirectMessage(
                holiday.discord_user_id,
                `👋 Your holiday has officially started! Enjoy your break. Reason: ${holiday.reason}. It ends on ${moment.tz(holiday.end_time, TIMEZONE).format('YYYY/MM/DD HH:mm')}.`
            );

            // Update status in Supabase only if Discord actions were attempted
            if (roleAdded && dmSent) {
                const { error: updateError } = await supabase
                    .from('holidays')
                    .update({ status: 'active' })
                    .eq('id', holiday.id);

                if (updateError) {
                    console.error(`Supabase update error for holiday ID ${holiday.id}:`, updateError);
                } else {
                    console.log(`[Scheduler] Holiday ID ${holiday.id} marked as 'active'.`);
                }
            } else {
                 console.warn(`[Scheduler] Could not complete all Discord actions for holiday ID ${holiday.id}. Keeping status as 'pending'.`);
                 // Optionally, you might want to add a retry mechanism or a "failed" status
            }
        }
    } catch (error) {
        console.error('[Scheduler] Error in start holiday cron job:', error);
    }
}, {
    timezone: TIMEZONE // Ensure cron job runs based on the specified timezone
});

// Cron job to check for holidays that need to end
// Runs every minute to check for completed holidays
cron.schedule('* * * * *', async () => {
    console.log(`[Scheduler] Checking for holidays to end at ${moment().tz(TIMEZONE).format('YYYY-MM-DD HH:mm:ss')}`);
    try {
        const now = moment().tz(TIMEZONE);
        const { data: holidays, error } = await supabase
            .from('holidays')
            .select('*')
            .eq('status', 'active')
            .lt('end_time', now.toISOString()); // Select holidays that should have ended by now

        if (error) {
            console.error('Supabase fetch error for ending holidays:', error);
            return;
        }

        for (const holiday of holidays) {
            console.log(`[Scheduler] Ending holiday for user ${holiday.discord_user_id}`);

            // Perform Discord actions
            const roleRemoved = await removeHolidayRole(holiday.discord_user_id);
            const dmSent = await sendDirectMessage(
                holiday.discord_user_id,
                `🎉 Your holiday has ended! Welcome back. If you still need time off, please re-apply.`
            );

            // Update status in Supabase only if Discord actions were attempted
            if (roleRemoved && dmSent) {
                const { error: updateError } = await supabase
                    .from('holidays')
                    .update({ status: 'completed' }) // Or delete the record: .delete()
                    .eq('id', holiday.id);

                if (updateError) {
                    console.error(`Supabase update error for holiday ID ${holiday.id}:`, updateError);
                } else {
                    console.log(`[Scheduler] Holiday ID ${holiday.id} marked as 'completed'.`);
                }
            } else {
                console.warn(`[Scheduler] Could not complete all Discord actions for holiday ID ${holiday.id}. Keeping status as 'active'.`);
                // Optionally, you might want to add a retry mechanism or a "failed" status
            }
        }
    } catch (error) {
        console.error('[Scheduler] Error in end holiday cron job:', error);
    }
}, {
    timezone: TIMEZONE // Ensure cron job runs based on the specified timezone
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log('Ensure you have a .env file with DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_HOLIDAY_ROLE_ID, SUPABASE_URL, SUPABASE_ANON_KEY.');
});

/*
// --- Instructions for .env file ---
// Create a file named `.env` in the same directory as this `index.js` file.
// Add the following variables to it, replacing the placeholder values:

// Discord Bot Token (from Discord Developer Portal)
DISCORD_BOT_TOKEN="YOUR_DISCORD_BOT_TOKEN_HERE"

// Discord Guild (Server) ID (right-click server icon in Discord -> Copy ID)
DISCORD_GUILD_ID="YOUR_DISCORD_GUILD_ID_HERE"

// Discord Role ID to add/remove for holidays (right-click role in Discord -> Copy ID)
DISCORD_HOLIDAY_ROLE_ID="YOUR_DISCORD_HOLIDAY_ROLE_ID_HERE"

// Supabase Project URL (from Supabase Project Settings -> API)
SUPABASE_URL="YOUR_SUPABASE_PROJECT_URL_HERE"

// Supabase Public Anon Key (from Supabase Project Settings -> API)
SUPABASE_ANON_KEY="YOUR_SUPABASE_PUBLIC_ANON_KEY_HERE"

// Optional: Timezone for scheduling (e.g., 'America/New_York', 'Europe/London', 'Asia/Tokyo')
// Default is 'Europe/Vilnius' (EEST)
TIMEZONE="Europe/Vilnius"


// --- Supabase Database Setup ---
// 1. Go to your Supabase project dashboard.
// 2. Navigate to 'Table Editor' -> 'New Table'.
// 3. Create a new table named `holidays` with the following columns:
//    - `id`: Type `uuid`, Primary Key, Default Value `gen_random_uuid()`
//    - `discord_user_id`: Type `text`
//    - `reason`: Type `text`
//    - `start_time`: Type `timestamp with time zone`
//    - `end_time`: Type `timestamp with time zone`
//    - `status`: Type `text` (e.g., 'pending', 'active', 'completed')

// --- Discord Bot Setup ---
// 1. Go to Discord Developer Portal (https://discord.com/developers/applications).
// 2. Create a New Application.
// 3. Go to 'Bot' section:
//    - Click 'Add Bot'.
//    - Copy the 'Token' and put it in your .env file.
//    - Enable 'PRESENCE INTENT', 'SERVER MEMBERS INTENT', and 'MESSAGE CONTENT INTENT' under 'Privileged Gateway Intents' if not already enabled.
// 4. Go to 'OAuth2' -> 'URL Generator':
//    - Select 'bot' scope.
//    - Select permissions: 'Manage Roles', 'Send Messages', 'Read Message History' (for DM sending context if needed), 'Send Messages in Threads', 'Use External Emojis', 'Read Message History'.
//    - Copy the generated URL and paste it into your browser to invite the bot to your server.
// 5. In your Discord server:
//    - Ensure the bot's role is higher than the `DISCORD_HOLIDAY_ROLE_ID` role in the role hierarchy.

// --- How to Run Locally ---
// 1. Make sure you have Node.js installed.
// 2. Create a new directory for your project.
// 3. Inside the directory, run: `npm init -y`
// 4. Install dependencies: `npm install express discord.js @supabase/supabase-js node-cron dotenv moment-timezone`
// 5. Create the `.env` file as described above.
// 6. Save the code above as `index.js`.
// 7. Run the application: `node index.js`

// --- How to Deploy to Railway ---
// 1. Create a new project on Railway.
// 2. Connect your GitHub repository (if using Git) or deploy directly.
// 3. Add the environment variables (DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, etc.) to Railway's 'Variables' section for your service.
// 4. Ensure your Supabase database is set up as described above.
// 5. Railway will automatically detect the Node.js app and run `npm install` and `npm start` (or `node index.js` if you don't have a start script).
//    - Tip: In your `package.json`, add `"start": "node index.js"` to the `scripts` section.

// --- Example API Call (using curl or Postman/Insomnia) ---
// POST http://localhost:3000/schedule-holiday
// Content-Type: application/json
// Body:
// {
//     "discordUserId": "YOUR_DISCORD_USER_ID", // Replace with an actual user ID
//     "reason": "Family vacation",
//     "startDate": "2025/06/18 10:00", // Format: YYYY/MM/DD HH:mm
//     "endDate": "2025/06/18 10:01"   // Format: YYYY/MM/DD HH:mm (for testing quickly)
// }
//
// Ensure that the Discord bot is invited to your guild and has the necessary permissions.
// The user ID for `discordUserId` must belong to a member in the `DISCORD_GUILD_ID`.
// The bot needs to have a role higher than the role it's trying to assign/remove.
*/
