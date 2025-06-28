// server.js
if (!globalThis.fetch) {
    globalThis.fetch = require('node-fetch');
}

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Google Sheets URLs
const ITINERARIES_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1kveuYiGZhWbhQG9VlSQLwc_82v4S3h5669iLh-qfS18/gviz/tq?tqx=out:json&sheet=Sheet1';
const DAILY_PLANS_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1kveuYiGZhWbhQG9VlSQLwc_82v4S3h5669iLh-qfS18/gviz/tq?tqx=out:json&gid=1158202961';

// Helper function to fetch and parse Google Sheets data
async function fetchGoogleSheetData(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const text = await response.text();
        // Parse Google Sheets JSON response (it comes wrapped in a function call)
        const jsonText = text.substring(47).slice(0, -2);
        const data = JSON.parse(jsonText);
        
        if (data.table && data.table.rows && data.table.rows.length > 0) {
            const headers = data.table.cols.map(col => col.label || col.id);
            
            // Convert rows to objects
            const rows = data.table.rows.map(row => {
                const obj = {};
                headers.forEach((header, index) => {
                    const cellValue = row.c[index] ? row.c[index].v : '';
                    obj[header] = cellValue;
                });
                return obj;
            }).filter(row => {
                // Filter out empty rows
                const title = row.title || row['title:'] || row['Title'] || '';
                return title && title.trim().length > 0;
            });
            
            return rows;
        }
        
        return [];
    } catch (error) {
        console.error('Error fetching Google Sheets data:', error);
        throw error;
    }
}

// API route to get all itineraries
app.get('/api/itineraries', async (req, res) => {
    try {
        console.log('📊 Fetching itineraries from Google Sheets...');
        const itineraries = await fetchGoogleSheetData(ITINERARIES_SHEET_URL);
        
        res.json({
            success: true,
            itineraries: itineraries,
            count: itineraries.length,
            lastUpdated: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error fetching itineraries:', error);
        res.status(500).json({ 
            error: 'Failed to fetch itineraries',
            message: error.message 
        });
    }
});

// API route to get daily plans for a specific itinerary
app.get('/api/daily-plans', async (req, res) => {
    try {
        const { itinerary_id } = req.query;
        
        if (!itinerary_id) {
            return res.status(400).json({ error: 'itinerary_id parameter is required' });
        }
        
        console.log('📊 Fetching daily plans for itinerary:', itinerary_id);
        const allDailyPlans = await fetchGoogleSheetData(DAILY_PLANS_SHEET_URL);
        
        // Filter daily plans for the specific itinerary
        const itineraryPlans = allDailyPlans.filter(plan => 
            plan.itinerary_id === itinerary_id
        );
        
        // Group by day and structure the data
        const dayGroups = {};
        itineraryPlans.forEach(plan => {
            const dayNumber = plan.day_number;
            if (!dayGroups[dayNumber]) {
                dayGroups[dayNumber] = {
                    day_number: dayNumber,
                    day_title: plan.day_title,
                    day_main_location: plan.day_main_location,
                    activities: []
                };
            }
            
            dayGroups[dayNumber].activities.push({
                activity_sequence: plan.activity_sequence,
                activity_description: plan.activity_description,
                activity_location_name: plan.activity_location_name,
                activity_time_of_day: plan.activity_time_of_day,
                activity_tags: plan.activity_tags_csv ? plan.activity_tags_csv.split(',').map(tag => tag.trim()) : []
            });
        });
        
        // Convert to array and sort by day number
        const days = Object.values(dayGroups).sort((a, b) => 
            parseInt(a.day_number) - parseInt(b.day_number)
        );
        
        // Sort activities within each day by sequence
        days.forEach(day => {
            day.activities.sort((a, b) => 
                parseInt(a.activity_sequence || 0) - parseInt(b.activity_sequence || 0)
            );
        });
        
        res.json({
            success: true,
            days: days,
            count: days.length,
            lastUpdated: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error fetching daily plans:', error);
        res.status(500).json({ 
            error: 'Failed to fetch daily plans',
            message: error.message 
        });
    }
});

// API route to generate itinerary options based on preferences
app.post('/generate-itinerary', async (req, res) => {
    try {
        console.log('🔍 Generating itinerary options for preferences:', req.body);
        
        const preferences = req.body;
        const allItineraries = await fetchGoogleSheetData(ITINERARIES_SHEET_URL);
        
        // Filter itineraries based on preferences
        let filteredOptions = allItineraries.filter(trip => {
            // Destination filter
            if (preferences.destination_country) {
                const destination = preferences.destination_country.toLowerCase();
                const tripRegion = (trip['region_definition:'] || trip.region || '').toLowerCase();
                const tripArrival = (trip['arrival_city:'] || trip.arrival_city || '').toLowerCase();
                
                const destinationMatch = 
                    tripRegion.includes(destination) || 
                    tripArrival.includes(destination) ||
                    (destination === 'vietnam' && (tripRegion.includes('vietnam') || tripArrival.includes('hanoi') || tripArrival.includes('ho chi minh'))) ||
                    (destination === 'singapore' && (tripRegion.includes('singapore') || tripArrival.includes('singapore'))) ||
                    (destination === 'india' && (tripRegion.includes('india') || tripArrival.includes('delhi') || tripArrival.includes('mumbai')));
                
                if (!destinationMatch) return false;
            }
            
            // Budget filter
            if (preferences.budget) {
                const tripBudget = (trip['budget_level_csv:'] || trip.budget_level || '').toLowerCase();
                const prefBudget = preferences.budget.toLowerCase();
                
                if (prefBudget === 'budget' && !tripBudget.includes('budget') && !tripBudget.includes('affordable')) return false;
                if (prefBudget === 'medium' && !tripBudget.includes('medium') && !tripBudget.includes('mid')) return false;
                if (prefBudget === 'luxury' && !tripBudget.includes('luxury') && !tripBudget.includes('high')) return false;
            }
            
            // Interest filter
            if (preferences.interests && preferences.interests.length > 0) {
                const tripInterests = [
                    trip['primary_interest_category:'] || trip.primary_interest || '',
                    trip['secondary_interest_tags_csv'] || trip.secondary_interests || ''
                ].join(',').toLowerCase();
                
                const hasMatchingInterest = preferences.interests.some(interest => 
                    tripInterests.includes(interest.toLowerCase())
                );
                
                if (!hasMatchingInterest) return false;
            }
            
            // Travel style filter
            if (preferences.travelStyle) {
                const tripTravellerTypes = (trip['traveller_type_tags_csv:'] || trip.traveller_types || '').toLowerCase();
                const style = preferences.travelStyle.toLowerCase();
                
                if (style === 'solo' && !tripTravellerTypes.includes('solo')) return false;
                if (style === 'couple' && !tripTravellerTypes.includes('couple')) return false;
                if (style === 'family' && !tripTravellerTypes.includes('family')) return false;
                if (style === 'group' && !tripTravellerTypes.includes('group') && !tripTravellerTypes.includes('friends')) return false;
            }
            
            return true;
        });
        
        // Randomize and limit results
        filteredOptions = filteredOptions
            .sort(() => 0.5 - Math.random())
            .slice(0, 12); // Limit to 12 options
        
        console.log(`✅ Found ${filteredOptions.length} matching itineraries`);
        
        res.json({
            success: true,
            options: filteredOptions,
            count: filteredOptions.length,
            preferences: preferences
        });
        
    } catch (error) {
        console.error('❌ Error generating itinerary:', error);
        res.status(500).json({ 
            error: 'Failed to generate itinerary options',
            message: error.message 
        });
    }
});

// Health check route
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve static files more explicitly
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/more_info.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'more_info.html'));
});

app.get('/itinerary_options.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'itinerary_options.html'));
});

app.get('/all_itineraries.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'all_itineraries.html'));
});

// Serve other static files
app.get('*', (req, res) => {
    const filePath = path.join(__dirname, 'public', req.path);
    if (require('fs').existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// For Vercel
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;