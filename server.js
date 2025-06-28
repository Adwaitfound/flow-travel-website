// server.js
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// Debug startup
console.log('🚀 Starting server...');
console.log('Environment check:');
console.log('- NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('- GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);
console.log('- Port:', PORT);

// Initialize Gemini AI with better error handling
let genAI = null;
let geminiModel = null;

try {
  if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    console.log('✅ Gemini AI initialized successfully');
  } else {
    console.log('⚠️ GEMINI_API_KEY not found in environment variables');
  }
} catch (error) {
  console.error('❌ Failed to initialize Gemini AI:', error.message);
}

// Google Sheets URLs
const SHEET_URLS = {
  itinerary: 'https://docs.google.com/spreadsheets/d/1kveuYiGZhWbhQG9VlSQLwc_82v4S3h5669iLh-qfS18/export?format=csv&gid=0',
  dailyPlan: 'https://docs.google.com/spreadsheets/d/1kveuYiGZhWbhQG9VlSQLwc_82v4S3h5669iLh-qfS18/export?format=csv&gid=1158202961'
};

// MIDDLEWARE SETUP
app.use(bodyParser.json());

// CORS handling
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Helper functions
function parseCSV(csv) {
  const lines = csv.split('\n').filter(line => line.trim());
  if (lines.length === 0) return [];
  
  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result.map(field => field.replace(/^"(.*)"$/, '$1'));
  }
  
  const headers = parseCSVLine(lines[0]);
  const data = lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] || '';
    });
    return obj;
  }).filter(obj => Object.values(obj).some(val => val !== ''));
  
  return data;
}

async function fetchSheetData() {
  try {
    console.log('📊 Fetching fresh data from Google Sheets...');
    
    const [itineraryResponse, dailyPlanResponse] = await Promise.all([
      fetch(SHEET_URLS.itinerary),
      fetch(SHEET_URLS.dailyPlan)
    ]);
    
    const itineraryCSV = await itineraryResponse.text();
    const dailyPlanCSV = await dailyPlanResponse.text();
    
    const itineraryData = parseCSV(itineraryCSV);
    const dailyPlanData = parseCSV(dailyPlanCSV);
    
    console.log('✅ Fresh data loaded:', {
      itineraries: itineraryData.length,
      dailyPlans: dailyPlanData.length
    });
    
    return {
      itinerary: itineraryData,
      dailyPlan: dailyPlanData,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    console.error('❌ Error fetching sheet data:', error);
    return null;
  }
}

// Cache for sheet data
let sheetDataCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 2 * 60 * 1000; // 2 minutes

// Add a new endpoint to force refresh data
app.get('/api/refresh-data', async (req, res) => {
  try {
    console.log('🔄 Force refreshing data from Google Sheets...');
    
    // Clear the cache
    sheetDataCache = null;
    lastFetchTime = 0;
    
    // Fetch fresh data
    const freshData = await fetchSheetData();
    if (freshData) {
      sheetDataCache = freshData;
      lastFetchTime = Date.now();
    }
    
    res.json({ 
      success: true, 
      message: 'Data refreshed successfully',
      lastUpdated: freshData?.lastUpdated,
      counts: {
        itineraries: freshData?.itinerary?.length || 0,
        dailyPlans: freshData?.dailyPlan?.length || 0
      }
    });
  } catch (error) {
    console.error('❌ Error force refreshing data:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Modify the getSheetData function to accept a force parameter
async function getSheetData(forceRefresh = false) {
  const now = Date.now();
  if (forceRefresh || !sheetDataCache || (now - lastFetchTime > CACHE_DURATION)) {
    console.log('💾 Fetching fresh data from Google Sheets...');
    const freshData = await fetchSheetData();
    if (freshData) {
      sheetDataCache = freshData;
      lastFetchTime = now;
      console.log('✅ Fresh data cached');
    }
  } else {
    console.log('📋 Using cached data');
  }
  return sheetDataCache;
}

function loadJsonItineraries() {
  const dbPath = path.join(__dirname, 'data', 'itineraries_db.json');
  if (fs.existsSync(dbPath)) {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  }
  return {};
}

// API ROUTES

// Test Gemini endpoint
app.get('/api/test-gemini', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'GEMINI_API_KEY not configured in environment variables',
        help: 'Please add GEMINI_API_KEY to your .env file'
      });
    }

    if (!genAI || !geminiModel) {
      return res.status(500).json({ 
        success: false, 
        error: 'Gemini AI not properly initialized',
        help: 'Check your API key and try restarting the server'
      });
    }
    
    console.log('🧪 Testing Gemini API...');
    const result = await geminiModel.generateContent("Say hello for a travel website test");
    const response = await result.response;
    const text = response.text();
    
    console.log('✅ Gemini test successful:', text.substring(0, 50) + '...');
    
    res.json({ 
      success: true, 
      response: text,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Gemini test error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.toString()
    });
  }
});

// Itineraries for homepage - FIXED to support force refresh
app.get('/api/itineraries', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    console.log('🏠 Fetching itineraries for homepage...', forceRefresh ? '(force refresh)' : '');
    
    const sheetData = await getSheetData(forceRefresh);
    if (sheetData && sheetData.itinerary) {
      console.log(`✅ Found ${sheetData.itinerary.length} itineraries from Google Sheets`);
      
      const transformedItineraries = sheetData.itinerary.map(item => ({
        id: item['id:'] || item.id,
        title: item['title:'] || item.title,
        description: item['description_long:'] || item.description,
        duration_days: parseInt(item['duration_days:'] || item.duration_days) || 0,
        image_url: item['image_url:'] || item.image_url,
        region: item['region_definition:'] || item.region,
        primary_interest: item['primary_interest_category:'] || item.primary_interest,
        budget_level: item['budget_level_csv:'] || item.budget_level,
        approx_cost_usd_pp: parseFloat(item['approx_cost_usd_pp:'] || item.approx_cost_usd_pp) || 0,
        arrival_city: item['arrival_city:'] || item.arrival_city,
        traveller_type_tags: item['traveller_type_tags_csv:'] || item.traveller_type_tags,
        // Include all original fields with colon suffix
        'id:': item['id:'],
        'title:': item['title:'],
        'description_long:': item['description_long:'],
        'duration_days:': item['duration_days:'],
        'image_url:': item['image_url:'],
        'region_definition:': item['region_definition:'],
        'primary_interest_category:': item['primary_interest_category:'],
        'budget_level_csv:': item['budget_level_csv:'],
        'approx_cost_usd_pp:': item['approx_cost_usd_pp:'],
        'arrival_city:': item['arrival_city:'],
        'traveller_type_tags_csv:': item['traveller_type_tags_csv:']
      }));
      
      res.json({ 
        itineraries: transformedItineraries,
        count: transformedItineraries.length,
        lastUpdated: sheetData.lastUpdated,
        refreshed: forceRefresh
      });
    } else {
      console.log('📁 Falling back to JSON itineraries');
      const db = loadJsonItineraries();
      const allItineraries = [
        ...(db.VIETNAM_ITINERARIES || []),
        ...(db.SINGAPORE_ITINERARIES || []),
        ...(db.INDIA_ITINERARIES || [])
      ];
      
      res.json({ 
        itineraries: allItineraries,
        count: allItineraries.length,
        source: 'json_fallback' 
      });
    }
  } catch (error) {
    console.error('❌ Error fetching itineraries:', error);
    res.status(500).json({ error: 'Failed to fetch itineraries' });
  }
});

// Daily plans endpoint - FIXED
app.get('/api/daily-plans', async (req, res) => {
  const itineraryId = req.query.itinerary_id;
  const forceRefresh = req.query.refresh === 'true';
  
  if (!itineraryId) {
    return res.status(400).json({ error: 'Missing itinerary_id parameter' });
  }

  try {
    console.log('🔍 Fetching daily plans for:', itineraryId, forceRefresh ? '(force refresh)' : '');
    
    const sheetData = await getSheetData(forceRefresh);
    if (sheetData && sheetData.dailyPlan) {
      const dailyPlans = sheetData.dailyPlan;
      const filteredPlans = dailyPlans.filter(plan => plan.itinerary_id === itineraryId);
      
      console.log(`📋 Found ${filteredPlans.length} plans for itinerary ${itineraryId}`);
      
      if (filteredPlans.length > 0) {
        const dayGroups = {};
        
        filteredPlans.forEach(plan => {    
          const dayNum = plan.day_number;
          
          if (!dayGroups[dayNum]) {
            dayGroups[dayNum] = {
              day_number: dayNum,
              day_title: plan.day_title,
              day_main_location: plan.day_main_location,
              daywise_image_url: plan['daywise Image_Url'] || plan.daywise_image_url || '',
              activities: []
            };
          }
          
          dayGroups[dayNum].activities.push({
            activity_sequence: plan.activity_sequence,
            activity_description: plan.activity_description,
            activity_location_name: plan.activity_location_name,
            activity_time_of_day: plan.activity_time_of_day,
            activity_tags: (plan.activity_tags_csv || '').split(',').map(s => s.trim()).filter(Boolean)
          });
        });
        
        const days = Object.values(dayGroups).sort((a, b) => 
          parseInt(a.day_number) - parseInt(b.day_number)
        );
        
        console.log(`✅ Returning ${days.length} days from Google Sheets`);
        return res.json({ 
          days, 
          lastUpdated: sheetData.lastUpdated,
          source: 'google_sheets',
          refreshed: forceRefresh
        });
      }
    }
    
    res.json({ days: [], source: 'no_data' });
    
  } catch (error) {
    console.error('Error in /api/daily-plans:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Featured itineraries endpoint - FIXED
app.get('/api/featured-itineraries', async (req, res) => {
  try {
    const destination = (req.query.destination || '').toLowerCase();
    const count = parseInt(req.query.count) || 3;
    
    const sheetData = await getSheetData();
    let itineraries = [];
    
    if (sheetData && sheetData.itinerary) {
      // Use Google Sheets data
      let allItineraries = sheetData.itinerary.map(item => ({
        id: item['id:'] || item.id,
        title: item['title:'] || item.title,
        description: item['description_long:'] || item.description,
        duration_days: parseInt(item['duration_days:'] || item.duration_days) || 0,
        image_url: item['image_url:'] || item.image_url,
        region: item['region_definition:'] || item.region,
        primary_interest: item['primary_interest_category:'] || item.primary_interest,
        budget_level: item['budget_level_csv:'] || item.budget_level,
        budget_tag: item['budget_level_csv:'] || item.budget_level, // For compatibility
        approx_cost_usd_pp: parseFloat(item['approx_cost_usd_pp:'] || item.approx_cost_usd_pp) || 0,
        destination_country_for_link: getCountryFromRegion(item['region_definition:'] || item.region)
      }));
      
      if (destination && destination !== 'any') {
        itineraries = allItineraries.filter(itin => {
          const regionLower = (itin.region || '').toLowerCase();
          return regionLower.includes(destination);
        });
      } else {
        itineraries = allItineraries;
      }
    } else {
      // Fallback to JSON data
      const db = loadJsonItineraries();
      if (destination === 'vietnam') itineraries = db.VIETNAM_ITINERARIES || [];
      else if (destination === 'singapore') itineraries = db.SINGAPORE_ITINERARIES || [];
      else if (destination === 'india') itineraries = db.INDIA_ITINERARIES || [];
      else itineraries = [
        ...(db.VIETNAM_ITINERARIES || []),
        ...(db.SINGAPORE_ITINERARIES || []),
        ...(db.INDIA_ITINERARIES || [])
      ];
    }

    const shuffled = itineraries.sort(() => 0.5 - Math.random());
    const featured = shuffled.slice(0, count);

    res.json({ 
      options: featured,
      count: featured.length,
      destination: destination
    });
  } catch (error) {
    console.error('❌ Error in featured itineraries:', error);
    res.status(500).json({ error: 'Failed to fetch featured itineraries' });
  }
});

// Generate itinerary endpoint - FIXED
app.post('/generate-itinerary', async (req, res) => {
  try {
    console.log('🎯 Generating itinerary options with preferences:', req.body);
    const prefs = req.body;
    
    // Get fresh data from Google Sheets
    const sheetData = await getSheetData();
    
    let allItineraries = [];
    
    if (sheetData && sheetData.itinerary) {
      console.log(`✅ Using ${sheetData.itinerary.length} itineraries from Google Sheets`);
      
      // Transform Google Sheets data
      allItineraries = sheetData.itinerary.map(item => ({
        id: item['id:'] || item.id,
        title: item['title:'] || item.title,
        description: item['description_long:'] || item.description,
        duration_days: parseInt(item['duration_days:'] || item.duration_days || 0),
        image_url: item['image_url:'] || item.image_url,
        region: item['region_definition:'] || item.region,
        primary_interest: item['primary_interest_category:'] || item.primary_interest,
        budget_level: item['budget_level_csv:'] || item.budget_level,
        approx_cost_usd_pp: parseFloat(item['approx_cost_usd_pp:'] || item.approx_cost_usd_pp || 0),
        arrival_city: item['arrival_city:'] || item.arrival_city,
        traveller_type_tags: item['traveller_type_tags_csv:'] || item.traveller_type_tags,
        destination_country_for_link: getCountryFromRegion(item['region_definition:'] || item.region),
        // Include raw fields for compatibility
        'id:': item['id:'],
        'title:': item['title:'],
        'description_long:': item['description_long:'],
        'duration_days:': item['duration_days:'],
        'image_url:': item['image_url:'],
        'region_definition:': item['region_definition:'],
        'primary_interest_category:': item['primary_interest_category:'],
        'budget_level_csv:': item['budget_level_csv:'],
        'approx_cost_usd_pp:': item['approx_cost_usd_pp:'],
        'arrival_city:': item['arrival_city:'],
        'traveller_type_tags_csv:': item['traveller_type_tags_csv:']
      }));
    } else {
      console.log('📁 Falling back to JSON itineraries');
      const db = loadJsonItineraries();
      allItineraries = [
        ...(db.VIETNAM_ITINERARIES || []),
        ...(db.SINGAPORE_ITINERARIES || []),
        ...(db.INDIA_ITINERARIES || [])
      ];
    }

    console.log(`📊 Total itineraries before filtering: ${allItineraries.length}`);

    // STEP 1: Apply REQUIRED filters (destination)
    let filtered = allItineraries.filter(itin => {
      if (prefs.destination_country && itin.region) {
        const regionLower = (itin.region || '').toLowerCase();
        const prefLower = prefs.destination_country.toLowerCase();
        return regionLower.includes(prefLower);
      }
      return true;
    });

    console.log(`🌍 After destination filter: ${filtered.length} itineraries`);

    // STEP 2: Apply STRICT BUDGET FILTERING if budget is specified
    if (prefs.budget) {
      console.log('💰 Applying STRICT budget filtering for:', prefs.budget);
      
      const budgetFiltered = filtered.filter(itin => {
        if (!itin.budget_level) return false; // Exclude if no budget info
        
        const itinBudget = (itin.budget_level || '').toLowerCase();
        const prefBudget = prefs.budget.toLowerCase();
        
        // Map form values to exact matches
        const budgetMatches = {
          'budget': ['budget', 'low', 'affordable', 'cheap', 'backpack'],
          'medium': ['medium', 'mid', 'moderate', 'pricey', 'standard'],
          'luxury': ['luxury', 'high', 'premium', 'expensive', 'deluxe']
        };
        
        // Get the keywords for the selected budget level
        const keywords = budgetMatches[prefBudget] || [prefBudget];
        
        // Check if the itinerary budget matches any of the keywords
        return keywords.some(keyword => itinBudget.includes(keyword));
      });
      
      console.log(`💰 After STRICT budget filtering: ${budgetFiltered.length} itineraries`);
      
      // If strict budget filtering results in too few options (less than 3), 
      // fall back to looser filtering but still prioritize exact matches
      if (budgetFiltered.length < 3) {
        console.log('⚠️ Too few budget matches, applying looser budget filtering...');
        
        // Try a more flexible approach using cost ranges
        filtered = filtered.filter(itin => {
          const cost = parseFloat(itin.approx_cost_usd_pp) || 0;
          const itinBudget = (itin.budget_level || '').toLowerCase();
          
          // If we have cost data, use that
          if (cost > 0) {
            if (prefs.budget === 'budget') return cost <= 150; // Under $150/day
            if (prefs.budget === 'medium') return cost > 150 && cost <= 300; // $150-300/day
            if (prefs.budget === 'luxury') return cost > 300; // Over $300/day
          }
          
          // Fall back to text matching if no cost data
          const prefBudget = prefs.budget.toLowerCase();
          return itinBudget.includes(prefBudget) || 
                 itinBudget.includes('budget') || 
                 itinBudget.includes('medium') || 
                 itinBudget.includes('luxury');
        });
        
        console.log(`🔄 After looser budget filtering: ${filtered.length} itineraries`);
      } else {
        filtered = budgetFiltered;
      }
    }

    // STEP 3: Apply STRICT INTEREST FILTERING if interests are specified
    if (prefs.interests && Array.isArray(prefs.interests) && prefs.interests.length > 0) {
      console.log('🎯 Applying STRICT interest filtering for:', prefs.interests);
      
      const interestFiltered = filtered.filter(itin => {
        const itinInterest = (itin.primary_interest || '').toLowerCase();
        const itinDescription = (itin.description || '').toLowerCase();
        const itinTitle = (itin.title || '').toLowerCase();
        
        // Check if the itinerary matches ANY of the selected interests
        return prefs.interests.some(interest => {
          const interestLower = interest.toLowerCase();
          
          // Direct match in primary interest field
          if (itinInterest.includes(interestLower)) {
            return true;
          }
          
          // Match in title or description with specific keywords
          const keywordMatches = {
            'beaches': ['beach', 'coast', 'island', 'bay', 'sea', 'ocean', 'coral', 'sand'],
            'mountains': ['mountain', 'hill', 'peak', 'highland', 'trekking', 'hiking', 'climb'],
            'adventure': ['adventure', 'trek', 'hike', 'climb', 'extreme', 'thrill', 'activity'],
            'culture': ['culture', 'temple', 'heritage', 'traditional', 'historic', 'museum', 'art'],
            'nature': ['nature', 'wildlife', 'forest', 'park', 'safari', 'eco', 'natural'],
            'city_exploration': ['city', 'urban', 'downtown', 'metropolitan', 'street', 'tour'],
            'food': ['food', 'culinary', 'cuisine', 'cooking', 'gastronomy', 'restaurant', 'local'],
            'history': ['history', 'historical', 'ancient', 'monument', 'ruins', 'archaeological']
          };
          
          const keywords = keywordMatches[interestLower] || [interestLower];
          
          return keywords.some(keyword => 
            itinTitle.includes(keyword) || 
            itinDescription.includes(keyword) ||
            itinInterest.includes(keyword)
          );
        });
      });
      
      console.log(`🎯 After STRICT interest filtering: ${interestFiltered.length} itineraries`);
      
      // If strict filtering results in too few options (less than 3), 
      // fall back to looser filtering but still prioritize exact matches
      if (interestFiltered.length < 3) {
        console.log('⚠️ Too few interest matches, applying looser interest filtering...');
        filtered = filtered.filter(itin => {
          const itinInterest = (itin.primary_interest || '').toLowerCase();
          const itinDescription = (itin.description || '').toLowerCase();
          const itinTitle = (itin.title || '').toLowerCase();
          const allText = `${itinTitle} ${itinDescription} ${itinInterest}`;
          
          return prefs.interests.some(interest => 
            allText.includes(interest.toLowerCase())
          );
        });
        console.log(`🔄 After looser interest filtering: ${filtered.length} itineraries`);
      } else {
        filtered = interestFiltered;
      }
    }

    // STEP 4: Apply scoring for final ranking
    const scoredItineraries = filtered.map(itin => {
      let score = 0;
      let matchReasons = [];
      
      // High score for exact budget matches
      if (prefs.budget && itin.budget_level) {
        const itinBudget = (itin.budget_level || '').toLowerCase();
        const prefBudget = prefs.budget.toLowerCase();
        
        const budgetMatches = {
          'budget': ['budget', 'low', 'affordable', 'cheap'],
          'medium': ['medium', 'mid', 'moderate', 'pricey'],
          'luxury': ['luxury', 'high', 'premium', 'expensive']
        };
        
        const keywords = budgetMatches[prefBudget] || [prefBudget];
        
        if (keywords.some(keyword => itinBudget.includes(keyword))) {
          score += 10; // High score for budget match
          matchReasons.push(`exact budget: ${prefs.budget}`);
        }
      }
      
      // High score for exact interest matches
      if (prefs.interests && prefs.interests.length > 0) {
        const itinInterest = (itin.primary_interest || '').toLowerCase();
        prefs.interests.forEach(interest => {
          if (itinInterest.includes(interest.toLowerCase())) {
            score += 10; // High score for primary interest match
            matchReasons.push(`exact interest: ${interest}`);
          }
        });
      }
      
      // Travel style matching
      if (prefs.travelStyle && itin.traveller_type_tags) {
        const itinTravelTypes = (itin.traveller_type_tags || '').toLowerCase();
        const prefStyle = prefs.travelStyle.toLowerCase();
        
        if (itinTravelTypes.includes(prefStyle) ||
            (prefStyle === 'solo' && itinTravelTypes.includes('individual')) ||
            (prefStyle === 'couple' && itinTravelTypes.includes('couple')) ||
            (prefStyle === 'family' && itinTravelTypes.includes('family')) ||
            (prefStyle === 'group' && itinTravelTypes.includes('friends'))) {
          score += 5;
          matchReasons.push('travel style match');
        }
      }
      
      // Duration preference
      if (prefs.startDate && prefs.endDate) {
        const startDate = new Date(prefs.startDate);
        const endDate = new Date(prefs.endDate);
        const preferredDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
        const itinDays = parseInt(itin.duration_days) || 0;
        
        if (itinDays > 0) {
          const daysDiff = Math.abs(itinDays - preferredDays);
          if (daysDiff <= 1) {
            score += 3;
            matchReasons.push('perfect duration');
          } else if (daysDiff <= 2) {
            score += 1;
            matchReasons.push('close duration');
          }
        }
      }
      
      // Add small random factor to prevent identical ordering
      score += Math.random() * 0.5;
      
      return {
        ...itin,
        matchScore: score,
        matchReasons: matchReasons
      };
    });

    // Sort by score (highest first)
    const sortedResults = scoredItineraries.sort((a, b) => b.matchScore - a.matchScore);
    
    console.log('🏆 Top scoring itineraries:');
    sortedResults.slice(0, 5).forEach((itin, index) => {
      console.log(`${index + 1}. ${itin.title} (Score: ${itin.matchScore}, Budget: ${itin.budget_level}, Reasons: ${itin.matchReasons.join(', ')})`);
    });

    // Return top 10 results
    const finalResults = sortedResults.slice(0, 10);

    console.log(`✅ Returning ${finalResults.length} itineraries`);

    // If we still have no results after filtering, return a helpful message
    if (finalResults.length === 0) {
      return res.json({ 
        options: [],
        total: 0,
        message: `No itineraries found matching your budget (${prefs.budget}) and interests. Try adjusting your preferences.`,
        searchCriteria: prefs
      });
    }

    // Return the filtered and scored results
    res.json({ 
      options: finalResults,
      total: finalResults.length,
      source: sheetData ? 'google_sheets' : 'json_fallback',
      lastUpdated: sheetData?.lastUpdated || new Date().toISOString(),
      searchCriteria: prefs
    });
    
  } catch (error) {
    console.error('❌ Error in /generate-itinerary:', error);
    res.status(500).json({ 
      error: 'Failed to generate itinerary options',
      message: error.message 
    });
  }
});

// Add this endpoint to debug your data
app.get('/api/debug-interests', async (req, res) => {
  try {
    const sheetData = await getSheetData(true); // Force refresh
    
    if (sheetData && sheetData.itinerary) {
      // Extract all unique values for debugging
      const interests = [...new Set(
        sheetData.itinerary
          .map(item => item['primary_interest_category:'] || item.primary_interest)
          .filter(interest => interest && interest.trim())
      )];
      
      const budgets = [...new Set(
        sheetData.itinerary
          .map(item => item['budget_level_csv:'] || item.budget_level)
          .filter(budget => budget && budget.trim())
      )];
      
      const regions = [...new Set(
        sheetData.itinerary
          .map(item => item['region_definition:'] || item.region)
          .filter(region => region && region.trim())
      )];
      
      res.json({
        interests: interests.sort(),
        budgets: budgets.sort(),
        regions: regions.sort(),
        totalItineraries: sheetData.itinerary.length,
        sampleItinerary: sheetData.itinerary[0]
      });
    } else {
      res.json({ error: 'No sheet data available' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function to determine country from region
function getCountryFromRegion(region) {
  if (!region) return '';
  const regionLower = region.toLowerCase();
  if (regionLower.includes('vietnam')) return 'vietnam';
  if (regionLower.includes('singapore')) return 'singapore';
  if (regionLower.includes('india')) return 'india';
  if (regionLower.includes('thailand')) return 'thailand';
  if (regionLower.includes('cambodia')) return 'cambodia';
  if (regionLower.includes('laos')) return 'laos';
  
  return region.toLowerCase();
}

// HTML ROUTES
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/trip_details', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'trip_details.html'));
});

app.get('/all_itineraries', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'all_itineraries.html'));
});

app.get('/show_itinerary', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'show_itinerary.html'));
});

app.get('/payment', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

// Test Gemini on startup with better error handling
(async () => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      console.log('⚠️ Gemini AI not configured - GEMINI_API_KEY missing');
      return;
    }

    if (!geminiModel) {
      console.log('⚠️ Gemini AI model not initialized');
      return;
    }

    console.log('🧪 Testing Gemini AI on startup...');
    const result = await geminiModel.generateContent("Test connection for travel app");
    const response = await result.response;
    const text = response.text();
    console.log('✅ Gemini AI working on startup:', text.substring(0, 50) + '...');
  } catch (error) {
    console.log('❌ Gemini AI startup test failed:', error.message);
    console.log('💡 This won\'t affect the main travel app functionality');
  }
})();

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Keep the helper function for backwards compatibility
function mapBudgetLevel(budget) {
  if (!budget) return '';
  
  const budgetLower = budget.toLowerCase();
  
  if (budgetLower === 'budget' || budgetLower === 'affordable') return 'budget';
  if (budgetLower === 'medium' || budgetLower === 'pricey') return 'medium';
  if (budgetLower === 'luxury') return 'luxury';
  
  return budget;
}

// Add this endpoint after the other API routes (around line 700)

// AI Trip Customization endpoint
app.post('/api/customize-trip', async (req, res) => {
  try {
    console.log('🤖 AI Trip customization request:', req.body);
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'AI service not configured',
        message: 'GEMINI_API_KEY not found in environment variables'
      });
    }

    if (!genAI || !geminiModel) {
      return res.status(500).json({ 
        success: false, 
        error: 'AI service not initialized',
        message: 'Gemini AI model not properly initialized'
      });
    }

    const { 
      itinerary_id, 
      user_request, 
      current_itinerary, 
      user_preferences,
      customization_type = 'general'
    } = req.body;

    if (!user_request || !current_itinerary) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields',
        message: 'user_request and current_itinerary are required'
      });
    }

    // Create a detailed prompt for Gemini
    const prompt = `
You are a professional travel advisor helping customize an existing itinerary. 

CURRENT ITINERARY:
Title: ${current_itinerary.title || 'Not specified'}
Duration: ${current_itinerary.duration_days || 0} days
Destination: ${current_itinerary.region || 'Not specified'}
Budget Level: ${current_itinerary.budget_level || 'Not specified'}
Current Description: ${current_itinerary.description || 'Not specified'}

USER'S CUSTOMIZATION REQUEST:
"${user_request}"

USER PREFERENCES:
${user_preferences ? JSON.stringify(user_preferences, null, 2) : 'Not specified'}

INSTRUCTIONS:
1. Analyze the user's request and current itinerary
2. Provide specific, actionable customization suggestions
3. Keep the same general destination and duration unless explicitly requested to change
4. Maintain the budget level unless user asks for changes
5. Focus on practical modifications that enhance the experience
6. If the request is unclear, ask clarifying questions

Please provide your response in the following JSON format:
{
  "customization_suggestions": "Your detailed suggestions here",
  "modified_activities": ["List of specific activity changes"],
  "additional_recommendations": ["Any extra recommendations"],
  "clarifying_questions": ["Any questions to better understand the request"],
  "estimated_cost_impact": "Brief note about cost changes if any"
}

Keep your response helpful, specific, and focused on improving the travel experience.
`;

    console.log('🔄 Sending request to Gemini AI...');
    
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    console.log('✅ Gemini AI response received:', text.substring(0, 100) + '...');

    // Try to parse JSON response, fallback to plain text if needed
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(text);
    } catch (parseError) {
      console.log('⚠️ Response not in JSON format, using plain text');
      parsedResponse = {
        customization_suggestions: text,
        modified_activities: [],
        additional_recommendations: [],
        clarifying_questions: [],
        estimated_cost_impact: "Not specified"
      };
    }

    res.json({ 
      success: true, 
      response: parsedResponse,
      raw_response: text,
      timestamp: new Date().toISOString(),
      itinerary_id: itinerary_id
    });

  } catch (error) {
    console.error('❌ Error in AI trip customization:', error);
    res.status(500).json({ 
      success: false, 
      error: 'AI service error',
      message: error.message,
      details: error.toString()
    });
  }
});

// AI Chat endpoint for general travel questions
app.post('/api/ai-chat', async (req, res) => {
  try {
    console.log('💬 AI Chat request:', req.body);
    
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'AI service not configured'
      });
    }

    if (!genAI || !geminiModel) {
      return res.status(500).json({ 
        success: false, 
        error: 'AI service not initialized'
      });
    }

    const { message, context = '' } = req.body;

    if (!message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Message is required'
      });
    }

    const prompt = `
You are a helpful travel assistant AI. Answer the user's travel-related question in a friendly, informative way.

${context ? `CONTEXT: ${context}` : ''}

USER QUESTION: ${message}

Please provide a helpful, accurate response about travel, destinations, activities, or trip planning. Keep your response concise but informative.
`;

    console.log('🔄 Sending chat request to Gemini AI...');
    
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    console.log('✅ AI Chat response received');

    res.json({ 
      success: true, 
      response: text,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error in AI chat:', error);
    res.status(500).json({ 
      success: false, 
      error: 'AI service error',
      message: error.message
    });
  }
});

// Add this endpoint after the other debug endpoints

app.get('/api/ai-status', (req, res) => {
  try {
    const status = {
      gemini_api_key_exists: !!process.env.GEMINI_API_KEY,
      gemini_api_key_length: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : 0,
      genai_initialized: !!genAI,
      model_initialized: !!geminiModel,
      model_name: geminiModel ? 'gemini-1.5-flash' : null,
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    };

    console.log('🔍 AI Status Check:', status);

    res.json({
      success: true,
      status: status,
      ready: status.gemini_api_key_exists && status.genai_initialized && status.model_initialized
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      status: {
        gemini_api_key_exists: !!process.env.GEMINI_API_KEY,
        genai_initialized: false,
        model_initialized: false,
        ready: false
      }
    });
  }
});