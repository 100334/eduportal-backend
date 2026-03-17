const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

console.log('='.repeat(50));
console.log('🔍 SUPABASE CONNECTION TEST');
console.log('='.repeat(50));
console.log('📡 Supabase URL:', supabaseUrl);
console.log('🔑 Anon Key exists:', supabaseKey ? '✅ YES' : '❌ NO');
console.log('🔑 Service Role Key exists:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ YES' : '❌ NO');
console.log('='.repeat(50));

const supabase = createClient(supabaseUrl, supabaseKey);

async function testConnection() {
  try {
    // Test 1: Simple connection test
    console.log('\n📡 Testing basic connection...');
    const { error: connectError } = await supabase
      .from('learners')
      .select('count', { count: 'exact', head: true });
    
    if (connectError) {
      console.error('❌ Connection failed:', connectError.message);
      
      if (connectError.message.includes('relation')) {
        console.log('\n👉 TABLES NOT FOUND: You need to create the database tables!');
        console.log('   Go to Supabase Dashboard → SQL Editor and run the schema.sql');
      } else if (connectError.message.includes('Invalid API key')) {
        console.log('\n👉 INVALID API KEY: Check your SUPABASE_ANON_KEY in .env');
      } else if (connectError.message.includes('fetch failed')) {
        console.log('\n👉 NETWORK ISSUE: Cannot reach Supabase');
        console.log('   Check your internet connection or firewall');
      }
      return false;
    }
    
    console.log('✅ Basic connection successful!');
    
    // Test 2: Try to fetch actual data
    console.log('\n📊 Attempting to fetch learners...');
    const { data: learners, error: fetchError } = await supabase
      .from('learners')
      .select('*')
      .limit(5);
    
    if (fetchError) {
      console.error('❌ Failed to fetch learners:', fetchError.message);
      return false;
    }
    
    console.log(`✅ Successfully fetched ${learners.length} learners`);
    if (learners.length > 0) {
      console.log('\n📋 Sample learner data:');
      console.log(learners);
    } else {
      console.log('⚠️ No learners found in database');
    }
    
    // Test 3: Check if other tables exist
    console.log('\n🔍 Checking other tables...');
    
    const tables = ['reports', 'attendance'];
    for (const table of tables) {
      const { error } = await supabase
        .from(table)
        .select('count', { count: 'exact', head: true });
      
      if (error) {
        console.log(`❌ Table '${table}': Not found`);
      } else {
        console.log(`✅ Table '${table}': Exists`);
      }
    }
    
    console.log('\n='.repeat(50));
    console.log('✅ DATABASE CONNECTION TEST COMPLETE');
    console.log('='.repeat(50));
    
    return true;
    
  } catch (err) {
    console.error('❌ Unexpected error:', err.message);
    return false;
  }
}

testConnection();