const { validationResult } = require('express-validator');

// Get all attendance records
exports.getAllAttendance = async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    const { startDate, endDate, learnerId } = req.query;

    let query = supabase
      .from('attendance')
      .select(`
        *,
        learners (
          name,
          reg_number,
          grade
        )
      `)
      .order('date', { ascending: false });

    if (startDate && endDate) {
      query = query.gte('date', startDate).lte('date', endDate);
    }

    if (learnerId) {
      query = query.eq('learner_id', learnerId);
    }

    const { data: attendance, error } = await query;

    if (error) throw error;

    res.json(attendance);
  } catch (error) {
    next(error);
  }
};

// Get attendance for a specific learner
exports.getLearnerAttendance = async (req, res, next) => {
  try {
    const { learnerId } = req.params;
    const { month, year } = req.query;
    const supabase = req.app.locals.supabase;

    let query = supabase
      .from('attendance')
      .select('*')
      .eq('learner_id', learnerId)
      .order('date', { ascending: false });

    if (month && year) {
      const startDate = `${year}-${month.padStart(2, '0')}-01`;
      const endDate = new Date(year, parseInt(month), 0).toISOString().split('T')[0];
      query = query.gte('date', startDate).lte('date', endDate);
    }

    const { data: attendance, error } = await query;

    if (error) throw error;

    // Calculate statistics
    const stats = {
      total: attendance.length,
      present: attendance.filter(a => a.status === 'present').length,
      absent: attendance.filter(a => a.status === 'absent').length,
      late: attendance.filter(a => a.status === 'late').length,
      rate: attendance.length 
        ? Math.round((attendance.filter(a => a.status !== 'absent').length / attendance.length) * 100)
        : 0
    };

    res.json({
      records: attendance,
      stats
    });
  } catch (error) {
    next(error);
  }
};

// Get attendance by date range
exports.getAttendanceByDateRange = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'Start date and end date are required' 
      });
    }

    const supabase = req.app.locals.supabase;

    const { data: attendance, error } = await supabase
      .from('attendance')
      .select(`
        *,
        learners (
          name,
          reg_number,
          grade
        )
      `)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });

    if (error) throw error;

    // Group by date
    const grouped = attendance.reduce((acc, record) => {
      if (!acc[record.date]) {
        acc[record.date] = [];
      }
      acc[record.date].push(record);
      return acc;
    }, {});

    res.json({
      dateRange: { startDate, endDate },
      grouped,
      total: attendance.length
    });
  } catch (error) {
    next(error);
  }
};

// Record single attendance
exports.recordAttendance = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { learnerId, date, status } = req.body;
    const supabase = req.app.locals.supabase;

    // Check if learner exists
    const { data: learner, error: learnerError } = await supabase
      .from('learners')
      .select('id')
      .eq('id', learnerId)
      .single();

    if (learnerError || !learner) {
      return res.status(404).json({ message: 'Learner not found' });
    }

    // Check if record already exists for this date
    const { data: existing } = await supabase
      .from('attendance')
      .select('id')
      .eq('learner_id', learnerId)
      .eq('date', date)
      .single();

    if (existing) {
      // Update existing
      const { data: updated, error: updateError } = await supabase
        .from('attendance')
        .update({ status })
        .eq('id', existing.id)
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json(updated);
    }

    // Create new
    const { data: attendance, error } = await supabase
      .from('attendance')
      .insert([{
        learner_id: learnerId,
        date,
        status
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(attendance);
  } catch (error) {
    next(error);
  }
};

// Bulk record attendance
exports.bulkRecordAttendance = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { records, date } = req.body;
    const supabase = req.app.locals.supabase;

    if (!date) {
      return res.status(400).json({ message: 'Date is required for bulk recording' });
    }

    // Prepare records
    const attendanceRecords = records.map(r => ({
      learner_id: r.learnerId,
      date,
      status: r.status
    }));

    // Use upsert to handle existing records
    const { data, error } = await supabase
      .from('attendance')
      .upsert(attendanceRecords, { 
        onConflict: 'learner_id,date',
        ignoreDuplicates: false 
      })
      .select();

    if (error) throw error;

    res.status(201).json({
      message: 'Attendance recorded successfully',
      count: data.length,
      records: data
    });
  } catch (error) {
    next(error);
  }
};

// Update attendance
exports.updateAttendance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const supabase = req.app.locals.supabase;

    const { data: attendance, error } = await supabase
      .from('attendance')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!attendance) {
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    res.json(attendance);
  } catch (error) {
    next(error);
  }
};

    // Delete attendance
exports.deleteAttendance = async (req, res, next) => {
  try {
    const { id } = req.params;
    const supabase = req.app.locals.supabase;

    const { error } = await supabase
      .from('attendance')
      .delete()
      .eq('id', id);

    if (error) throw error;

    res.json({ 
      success: true,
      message: 'Attendance record deleted successfully' 
    });
  } catch (error) {
    next(error);
  }
};

// Get attendance statistics
exports.getAttendanceStats = async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    const { startDate, endDate, grade } = req.query;

    let query = supabase
      .from('attendance')
      .select(`
        *,
        learners (
          id,
          name,
          grade,
          status
        )
      `);

    // Apply date filters
    if (startDate && endDate) {
      query = query.gte('date', startDate).lte('date', endDate);
    }

    // Apply grade filter
    if (grade) {
      query = query.eq('learners.grade', grade);
    }

    const { data: attendance, error } = await query;

    if (error) throw error;

    // Calculate overall statistics
    const totalRecords = attendance.length;
    const presentCount = attendance.filter(a => a.status === 'present').length;
    const absentCount = attendance.filter(a => a.status === 'absent').length;
    const lateCount = attendance.filter(a => a.status === 'late').length;

    // Calculate daily averages
    const uniqueDates = [...new Set(attendance.map(a => a.date))];
    const dailyStats = uniqueDates.map(date => {
      const dayRecords = attendance.filter(a => a.date === date);
      const dayPresent = dayRecords.filter(a => a.status === 'present').length;
      const dayLate = dayRecords.filter(a => a.status === 'late').length;
      
      return {
        date,
        total: dayRecords.length,
        present: dayPresent,
        absent: dayRecords.filter(a => a.status === 'absent').length,
        late: dayLate,
        attendanceRate: dayRecords.length ? 
          Math.round(((dayPresent + dayLate) / dayRecords.length) * 100) : 0
      };
    });

    // Group by grade
    const byGrade = attendance.reduce((acc, record) => {
      const grade = record.learners?.grade || 'Unknown';
      if (!acc[grade]) {
        acc[grade] = {
          total: 0,
          present: 0,
          absent: 0,
          late: 0
        };
      }
      acc[grade].total++;
      acc[grade][record.status]++;
      return acc;
    }, {});

    // Calculate grade percentages
    const gradeStats = Object.entries(byGrade).map(([grade, stats]) => ({
      grade,
      ...stats,
      attendanceRate: Math.round(((stats.present + stats.late) / stats.total) * 100)
    }));

    // Get top/bottom performers
    const learnerStats = {};
    attendance.forEach(record => {
      const learnerId = record.learner_id;
      if (!learnerStats[learnerId]) {
        learnerStats[learnerId] = {
          learnerId,
          learnerName: record.learners?.name || 'Unknown',
          grade: record.learners?.grade || 'Unknown',
          total: 0,
          present: 0,
          absent: 0,
          late: 0
        };
      }
      learnerStats[learnerId].total++;
      learnerStats[learnerId][record.status]++;
    });

    const learnerPerformance = Object.values(learnerStats)
      .map(stats => ({
        ...stats,
        attendanceRate: Math.round(((stats.present + stats.late) / stats.total) * 100)
      }))
      .sort((a, b) => b.attendanceRate - a.attendanceRate);

    res.json({
      summary: {
        totalRecords,
        totalPresent: presentCount,
        totalAbsent: absentCount,
        totalLate: lateCount,
        overallAttendanceRate: totalRecords ? 
          Math.round(((presentCount + lateCount) / totalRecords) * 100) : 0,
        totalDays: uniqueDates.length,
        averageDailyAttendance: dailyStats.length ?
          Math.round(dailyStats.reduce((sum, day) => sum + day.attendanceRate, 0) / dailyStats.length) : 0
      },
      dailyStats,
      gradeStats,
      topPerformers: learnerPerformance.slice(0, 5),
      bottomPerformers: learnerPerformance.slice(-5).reverse(),
      dateRange: {
        startDate: startDate || 'All time',
        endDate: endDate || 'All time'
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get today's attendance summary
exports.getTodaysAttendance = async (req, res, next) => {
  try {
    const supabase = req.app.locals.supabase;
    const today = new Date().toISOString().split('T')[0];

    const { data: attendance, error } = await supabase
      .from('attendance')
      .select(`
        *,
        learners (
          id,
          name,
          grade,
          status
        )
      `)
      .eq('date', today);

    if (error) throw error;

    // Get total active learners
    const { count: totalLearners, error: countError } = await supabase
      .from('learners')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'Active');

    if (countError) throw countError;

    const presentCount = attendance.filter(a => a.status === 'present').length;
    const absentCount = attendance.filter(a => a.status === 'absent').length;
    const lateCount = attendance.filter(a => a.status === 'late').length;
    const notRecorded = totalLearners - attendance.length;

    res.json({
      date: today,
      summary: {
        total: totalLearners,
        recorded: attendance.length,
        notRecorded,
        present: presentCount,
        absent: absentCount,
        late: lateCount,
        attendanceRate: totalLearners ? 
          Math.round(((presentCount + lateCount) / totalLearners) * 100) : 0
      },
      details: attendance
    });
  } catch (error) {
    next(error);
  }
};

// Get monthly attendance report
exports.getMonthlyReport = async (req, res, next) => {
  try {
    const { year, month, grade } = req.query;
    const supabase = req.app.locals.supabase;

    if (!year || !month) {
      return res.status(400).json({ 
        message: 'Year and month are required' 
      });
    }

    const startDate = `${year}-${month.padStart(2, '0')}-01`;
    const endDate = new Date(year, parseInt(month), 0).toISOString().split('T')[0];

    let query = supabase
      .from('attendance')
      .select(`
        *,
        learners (
          id,
          name,
          grade,
          reg_number
        )
      `)
      .gte('date', startDate)
      .lte('date', endDate);

    if (grade) {
      query = query.eq('learners.grade', grade);
    }

    const { data: attendance, error } = await query;

    if (error) throw error;

    // Get all learners for the selected grade
    let learnerQuery = supabase
      .from('learners')
      .select('id, name, reg_number, grade')
      .eq('status', 'Active');

    if (grade) {
      learnerQuery = learnerQuery.eq('grade', grade);
    }

    const { data: learners, error: learnerError } = await learnerQuery;

    if (learnerError) throw learnerError;

    // Calculate days in month
    const daysInMonth = new Date(year, parseInt(month), 0).getDate();
    const dates = Array.from({ length: daysInMonth }, (_, i) => {
      const date = new Date(year, parseInt(month) - 1, i + 1);
      return date.toISOString().split('T')[0];
    });

    // Create attendance matrix
    const matrix = learners.map(learner => {
      const learnerRecords = attendance.filter(a => a.learner_id === learner.id);
      const dailyAttendance = dates.reduce((acc, date) => {
        const record = learnerRecords.find(r => r.date === date);
        acc[date] = record ? record.status : 'not_recorded';
        return acc;
      }, {});

      const totalPresent = learnerRecords.filter(r => r.status === 'present').length;
      const totalLate = learnerRecords.filter(r => r.status === 'late').length;
      const totalAbsent = learnerRecords.filter(r => r.status === 'absent').length;

      return {
        ...learner,
        attendance: dailyAttendance,
        summary: {
          present: totalPresent,
          late: totalLate,
          absent: totalAbsent,
          total: learnerRecords.length,
          rate: learnerRecords.length ?
            Math.round(((totalPresent + totalLate) / daysInMonth) * 100) : 0
        }
      };
    });

    // Calculate daily summaries
    const dailySummaries = dates.map(date => {
      const dayRecords = attendance.filter(a => a.date === date);
      return {
        date,
        present: dayRecords.filter(r => r.status === 'present').length,
        late: dayRecords.filter(r => r.status === 'late').length,
        absent: dayRecords.filter(r => r.status === 'absent').length,
        total: dayRecords.length
      };
    });

    res.json({
      month: `${year}-${month}`,
      year,
      monthName: new Date(year, parseInt(month) - 1).toLocaleString('default', { month: 'long' }),
      daysInMonth,
      dates,
      summary: {
        totalLearners: learners.length,
        totalDays: daysInMonth,
        averageAttendance: Math.round(
          dailySummaries.reduce((sum, day) => 
            sum + (day.total ? ((day.present + day.late) / day.total) * 100 : 0), 0
          ) / daysInMonth
        )
      },
      dailySummaries,
      learnerReports: matrix
    });
  } catch (error) {
    next(error);
  }
};

// Export attendance report (CSV format)
exports.exportAttendanceReport = async (req, res, next) => {
  try {
    const { startDate, endDate, format = 'csv' } = req.query;
    const supabase = req.app.locals.supabase;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        message: 'Start date and end date are required' 
      });
    }

    const { data: attendance, error } = await supabase
      .from('attendance')
      .select(`
        *,
        learners (
          name,
          reg_number,
          grade
        )
      `)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true })
      .order('learner_id', { ascending: true });

    if (error) throw error;

    if (format === 'csv') {
      // Generate CSV
      const headers = ['Date', 'Learner Name', 'Registration Number', 'Grade', 'Status'];
      const csvRows = [];
      
      // Add headers
      csvRows.push(headers.join(','));
      
      // Add data rows
      attendance.forEach(record => {
        const row = [
          record.date,
          `"${record.learners?.name || 'Unknown'}"`,
          record.learners?.reg_number || 'N/A',
          record.learners?.grade || 'N/A',
          record.status
        ];
        csvRows.push(row.join(','));
      });

      const csvString = csvRows.join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=attendance-${startDate}-to-${endDate}.csv`);
      res.send(csvString);
    } else {
      // Return JSON
      res.json(attendance);
    }
  } catch (error) {
    next(error);
  }
};