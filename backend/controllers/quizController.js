const Quiz = require('../models/Quiz');
const QuizResult = require('../models/QuizResult');
const QuizProgress = require('../models/QuizProgress');
const User = require("../models/User");
const generateUniqueId = require('generate-unique-id');
const validations = require('../validators/validations');

function calculateScore(answers, questions) {
  return answers.reduce((score, answer) => {
    const question = questions.find(q => q._id.toString() === answer.question_id);
    return question && question.correctAnswer === answer.selectedOption ? score + 1 : score;
  }, 0);
}

function findQuartile(sortedArray, percentile) {
  const index = Math.ceil(percentile * (sortedArray.length + 1)) - 1;
  return sortedArray[index];
}

const createQuiz = async (req, res) => {
  const zodResult = validations.quizSchema.safeParse(req.body);
  if (!zodResult.success) {
    const errors = zodResult.error.errors.map(err => err.message).join(', ');
    return res.status(400).json({ msg: errors });
  }

  let { title, questions, timeLimit } = zodResult.data;
  const user = await User.findById(req.user.id);
  const quiz_id = `${user.username}_${generateUniqueId({ length: 10, useLetters: true, useNumbers: true })}`;

  try {
    const existingQuiz = await Quiz.findOne({ quiz_id });
    if (existingQuiz) return res.status(400).json({ msg: 'Quiz ID already exists' });

    const newQuiz = new Quiz({ title, quiz_id, questions, createdBy: req.user.id, timeLimit });
    const quiz = await newQuiz.save();
    res.status(201).json(quiz);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

const getQuizStats = async (req, res) => {
  try {
    const quizResults = await QuizResult.find({ quiz_id: req.params.quiz_id });
    if (quizResults.length === 0) return res.status(404).json({ msg: 'No results found for this quiz' });

    const quiz = await Quiz.findOne({ quiz_id: req.params.quiz_id });
    if (quiz.createdBy.toString() !== req.user.id && !quiz.takenBy.includes(req.user.id)) {
      return res.status(403).json({ msg: 'Unauthorized access' });
    }

    const scores = quizResults.map(result => result.score);
    const sortedScores = [...scores].sort((a, b) => a - b);
    const count = sortedScores.length;

    const min = sortedScores[0];
    const max = sortedScores[count - 1];
    const mean = scores.reduce((acc, score) => acc + score, 0) / count;
    const median = count % 2 === 0 
      ? (sortedScores[count / 2 - 1] + sortedScores[count / 2]) / 2 
      : sortedScores[Math.floor(count / 2)];

    const lowerQuartile = findQuartile(sortedScores, 0.25);
    const upperQuartile = findQuartile(sortedScores, 0.75);

    res.json({ min, max, mean, median, lowerQuartile, upperQuartile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

const getQuizByUser = async (req, res) => {
  try {
    const quizzes = await Quiz.find({ createdBy: req.user.id }).select('title lastUpdated quiz_id timeLimit questions takenBy');
    const response = quizzes.map(quiz => ({
      title: quiz.title,
      quiz_id: quiz.quiz_id,
      lastUpdated: quiz.lastUpdated,
      numberOfQuestions: quiz.questions.length,
      numberOfTakenBy: quiz.takenBy.length,
      timeLimit: quiz.timeLimit,
    }));

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

const getQuizTakenByUser = async (req, res) => {
  try {
    const quizzes = await Quiz.find({ takenBy: req.user.id });
    if (!quizzes.length) return res.json([]);

    const quizzesWithDetails = await Promise.all(quizzes.map(async quiz => {
      const quizResult = await QuizResult.findOne({ quiz_id: quiz.quiz_id, user_id: req.user.id });
      return {
        quiz_id: quiz.quiz_id,
        title: quiz.title,
        numQuestions: quiz.questions.length,
        quizScore: quizResult ? quizResult.score : null,
      };
    }));

    res.json(quizzesWithDetails);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

const updateQuizById = async (req, res) => {
  const zodResult = validations.quizUpdateSchema.safeParse(req.body);
  if (!zodResult.success) {
    const errors = zodResult.error.errors.map(err => err.message).join(', ');
    return res.status(400).json({ msg: errors });
  }

  const { title, timeLimit, questions } = zodResult.data;
  const { quiz_id } = req.params;

  try {
    const quiz = await Quiz.findOne({ quiz_id });
    if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

    quiz.title = title || quiz.title;
    quiz.timeLimit = timeLimit || quiz.timeLimit;

    if (questions) {
      questions.forEach(q => {
        const existingQuestion = quiz.questions.find(existingQ => existingQ._id.toString() === q._id);
        if (existingQuestion) {
          existingQuestion.question = q.question;
          existingQuestion.options = q.options;
          existingQuestion.correctAnswer = q.correctAnswer;
        } else {
          quiz.questions.push({ question: q.question, options: q.options, correctAnswer: q.correctAnswer });
        }
      });
    }

    quiz.lastUpdated = Date.now();
    await quiz.save();

    const attendees = quiz.takenBy;
    await Promise.all(attendees.map(async userId => {
      const userResults = await QuizResult.findOne({ quiz_id, user_id: userId });
      if (userResults) {
        const newScore = userResults.answers.reduce((score, answer) => {
          const question = quiz.questions.find(q => q._id.toString() === answer.question_id.toString());
          return question && question.correctAnswer === answer.selectedOption ? score + 1 : score;
        }, 0);
        
        userResults.score = newScore;
        await userResults.save();
      }
    }));

    res.json({ msg: 'Quiz and results updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

const fetchQuizToTake = async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ quiz_id: req.params.quiz_id });
    if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

    const questionsWithoutCorrectAnswer = quiz.questions.map(({ correctAnswer, ...question }) => question);
    res.json({ title: quiz.title, quiz_id: quiz.quiz_id, questions: questionsWithoutCorrectAnswer, createdBy: quiz.createdBy, lastUpdated: quiz.lastUpdated, timeLimit: quiz.timeLimit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

const searchQuiz = async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ quiz_id: req.params.quiz_id })
      .select('title lastUpdated quiz_id timeLimit questions takenBy createdBy -_id -__v');

    if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

    const user = await User.findById(quiz.createdBy);
    const username = user ? user.username : 'Unknown';

    const data = {
      title: quiz.title,
      quiz_id: quiz.quiz_id,
      lastUpdated: quiz.lastUpdated,
      timeLimit: quiz.timeLimit,
      questions: quiz.questions.length,
      takenBy: quiz.takenBy.length,
      createdBy: username,
    };

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server error' });
  }
};

const markQuizAsTaken = async (req, res) => {
  const { answers } = req.body;

  try {
    const quiz = await Quiz.findOne({ quiz_id: req.params.quiz_id });
    if (!quiz) return res.status(404).json({ msg: 'Quiz not found' });

    if (!quiz.takenBy.includes(req.user.id)) {
      quiz.takenBy.push(req.user.id);
      await quiz.save();
    } else {
      return res.status(400).json({ msg: 'Quiz already taken' });
    }

    const quizProgress = await QuizProgress.findOne({ quiz_id: req.params.quiz_id, user_id: req.user.id });
    if (quizProgress) {
      quizProgress.completed = true;
      await quizProgress.save();
    }

    const processedAnswers = answers.map(answer => {
      const question = quiz.questions.find(q => q
