const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function checkClassesAndSubjects() {
  try {
    console.log('🔍 Checking classes and subjects...');

    // Get all classes
    const { data: classes, error: classesError } = await supabase
      .from('classes')
      .select('*')
      .order('name');

    if (classesError) throw classesError;

    console.log('\n📚 Available Classes:');
    console.log(classes);

    // Check subjects for each class
    for (const cls of classes || []) {
      const { data: subjects, error: subjectsError } = await supabase
        .from('subjects')
        .select('*')
        .eq('class_id', cls.id);

      console.log(`\n📖 Subjects for ${cls.name} (ID: ${cls.id}):`);
      if (subjectsError) {
        console.log('❌ Error:', subjectsError.message);
      } else {
        console.log(subjects && subjects.length > 0 ? subjects : '⚠️ No subjects found');
      }
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkClassesAndSubjects();