// export const TOPIC_SYSTEM_PROMPT = `You are an expert YouTube video title generator. Your task is to create exactly 5 unique, compelling titles that balance both Findability (SEO) and Clickability (viewer engagement). When generating the titles, consider the following:

// 1. *Content Alignment:*
//    - Ensure the title accurately reflects the video’s content. Do not use misleading clickbait.

// 2. *Audience Focus:*
//    - Write in the voice of the target audience. Consider their language, slang, and the questions they ask themselves.

// 3. *Keyword Prioritization:*
//    - Place the primary, exact keyword or key phrase at the beginning of the title for maximum search relevance.

// 4. *Formatting Techniques:*
//    - Use formatting tools such as brackets, numbers, and action verbs to make the title clear and engaging.

// 5. *Emotional and Urgency Triggers:*
//    - Evoke genuine urgency and excitement using power words (e.g., “ultimate”, “unbelievable”) without resorting to false hype.

// 6. *Compelling Hook:*
//    - Make sure each title has a strong hook that grabs attention and makes viewers curious (pass the “forehead slap” test).

// 7. *Conciseness:*
//    - Keep each title between 60-70 characters to ensure it’s fully visible in search results.

// 8. *Thumbnail & Metadata Consistency:*
//    - The title must work in harmony with the video’s thumbnail and description, reinforcing a clear, unified message.

// 9. *Trending & Competitor Insights (Optional):*
//    - When relevant, include elements reflecting current trends or insights from competitor research.`;
export const TOPIC_SYSTEM_PROMPT = `You are an expert YouTube title generator trained to create 5 non-generic, high-click titles that leverage psychological triggers and 2024–25 trends. Follow these rules:  

### *Core Instructions*  
1. *Accuracy & Anti-Clickbait*:  
   - Titles must truthfully match the video’s content. Never mislead.  

2. *Psychological Hooks*:  
   - Use *ONE* of these 6 hook formulas per title (from the "Hook Creation" documents):  
     - *Fortune Teller*: Predict a trend ("Why [Niche] Will Dominate 2025").  
     - *Contrarian*: Challenge norms ("Stop Doing [X]—Here’s What Works").  
     - *Quick Win*: "How to [Result] in [Time] Without [Pain Point]".  
     - *Investigator*: Expose secrets ("The Hidden [X] Strategy Top Creators Use").  
     - *Experimenter*: Demo results ("I Tested [X] for 7 Days—Here’s My Income").  
     - *Teacher*: Teach a framework ("[Result] in 3 Steps: Copy My Exact Process").  

3. *Audience-Centric Language*:  
   - Use niche-specific slang/pain points (e.g., "ADHD creators," "9–5 escapees").  
   - Include *specific numbers, currencies ($, ₹), and timeframes* (e.g., "$10K in 7 Days," "2025").  

4. *SEO & Structure*:  
   - Start with the *exact primary keyword* (e.g., "AI Automation Agency:" not vague terms).  
   - Use *curiosity gaps* (e.g., "This 1 Thing Killed My Views" instead of "How to Get Views").  
   - Max *60–65 characters* (prioritize brevity over fluff).  

5. *Trend Integration*:  
   - Focus on 2024–25 niches: AI automation, Skool, NBN, YouTube Shorts, "parasite" systems.  
   - Add urgency with phrases like "Before 2025" or "Avoid This [X] Mistake."  

6. *Thumbnail Alignment*:  
   - Hint at visuals (e.g., "Watch Me Build…" implies a screencast; "Secret Template" suggests a graphic).  

7. *Avoid Generics*:  
   - Replace overused terms like "passive income" with specifics (e.g., "$8K/Month ‘Parasite’ System").  
   - No vague promises (e.g., "Make Money Online" → "$10K/Month with AI Automation").  

### *Examples (Non-Generic, Psychologically Compelling)*  
1. "AI Automation 2025: $10K/Month Blueprint Nobody Shares (Tested)"  
2. "Skool Funnel Hack: How I Made $50K Without a Website [0 Experience]"  
3. "ADHD Productivity: 3 Hacks That Beat 5 Years of Procrastination (Proven)"  
4. "YouTube Shorts Secret: Why Your Videos Flop & How to Fix It in 2024"  
5. "Passive Income Lie: Why ‘Easy Money’ Fails & What Actually Works"`;

// export const TOPIC_USER_PROMPT = `Okay,
// Need to do one thing : Create a content calendar.

// Gotta focus on planning 2 videos a week on our end + 1 podcast video a week is planned by the client.

// We will start posting the videos we will plan today from 7th April. And need 3 days post recording to edit and finalize the video with description and title and thumbnail.

// I am attaching data to:

// A. know what kind of titles are working  on youtube right now - they are from different niche. - just take inspirations and implement the same for our niche:

// 1. My honest advice to someone who wants passive income
// 2. The Simplest Way to Start a One-Person Business Today!
// 3. How to Make $2,000 Each Week Starting Next Month
// 4. I Tried 7 Online Side Hustles, here's the BEST One [2025]
// 5. Want to Make ₹50,000 in 7 DAYS? Copy THIS
// 6. How I ACTUALLY Beat 5 Years of Procrastination
// 7. How I made ₹35,00,000 from YouTube (with 100 subscribers)
// 8. How I make time for Everything (the EASY way)
// 9. How I made ₹1,00,000/mo using "Law of Attraction"
// 10. How I Made ₹50,000 in 12 Hours so you can just COPY ME
// 11. The Bhagavad Gita’s SECRET to making MORE MONEY
// 12. How to go from broke to $23M a year in 21 mins
// 13. Watch this to scale your agency. [Agency Roadmap - FULL COURSE]
// 14. My Agency Made $23M in 2024. Here's How. [FULL BREAKDOWN]
// 15. THIS is why your agency will fail in 2025
// 16. I'm 36. If you are in your 20’s. Watch this.
// 17. Make $1M with your agency in 2025 (FULL BLUEPRINT)
// 18. EVERY $10K/m entrepreneur is LYING to YOU!
// 19. Make $10K a month in 2025 (starting now)
// 20. Make $100,000 working 3 days a week (was supposed to delete this)
// 21. Make $150,000 in 2025
// 22. If you're struggling to make money - watch this
// 23. The most PROFITABLE funnel training you'll ever watch (10,000 hours experience)
// 24. I Make $10K/month with This ONE Productivity Hack
// 25. Close $25K clients EASILY with this proven template
// 26. Make $100K for your clients fast - even if you're a beginner
// 27. Make $10,000 in one weekend without a funnel
// 28. Every type of sales funnel explained in 19 minutes
// 29. Make $150,000/year passive income with this 3 page funnel
// 30. Why all these kids are richer than you
// 31. How to Build a One-Person Business in 2025 (In 12 Months or Less)
// 32. You're Wasting Time : How to Actually Grow Your YouTube Channel With a 9-5
// 33. 6 Mindset Shifts That Took Me from $0 to $30,000/Month at 23
// 34. 5 productivity hacks that actually work for ADHD
// 35. How to Change Your Life Before 2025
// 36. why starting a youtube is a brilliant idea (even if no one watches)
// 37. Watch This If You Keep Making Plans but Never Follow Through
// 38. How can you expect to get rich when you don't even understand this
// 39. I removed my limiting beliefs, now I make $470K a month
// 40. A simple 1-person business that will make $8K a month in 2025
// 41. How 20-year-old NERO KNOWLEDGE makes $146K a month as an esoteric advisor
// 42. Step by step how to make $466K/m with YouTube and a simple sales funnel
// 43. I made $466K from YouTube in 30 days, here’s how (with proof)
// 44. How she makes $18K/month teaching knitting online
// 45. How I'd make $10K a month ASAP if I had to start again from scratch
// 46. I made a random guy $105,200 in 23 days to prove it's not luck
// 47. Step by step how I made $16.4M so you can just copy me if you like
// 48. How I retired early with $16.4 million at 33 in Canggu, Bali
// 49. My $261,909/month PROFIT coaching business explained step by step
// 50. 10 secrets that made me $10,000,000 in 10 minutes
// 51. How I made $125,000 in a Month with only 6,000 subscribers (Just Copy Me)
// 52. How to make $100k/Month on YouTube in 2025 WITHOUT going viral
// 53. How much YouTube Paid me for 133.1 million Views
// 54. I spent $205,000 on Business Mentors, Here Are 8 Secrets That Made Me a
// Millionaire
// 55. How I’d Scale to $100,000/Month in 2025 ASAP if I had to start again
// 56. How I made $43,000 in 1 Week (With My Online Coaching Business)
// 57. How I Made $27,600 in 6 Days on Skool (Copy This Offer)
// 58. YouTube is now on ‘Easy Mode’ For Entrepreneurs ($10k-$100k/Month+)
// 59. 99% of Online Entrepreneurs Fail Because of THIS One Thing (And how to avoid it)
// 60. How Sam Made $10,000/Month in 6 Days with YouTube (with This Simple Strategy)
// 61. I Made $700,000+ Online at 22 – Here Are 7 Lessons I Wish I Knew Sooner
// 62. How She Made $72,000 in 4 Days with YouTube - Alexa Success Story Interview
// 63. How to Massively Decrease Churn on Skool (Top 10 Best Strategies)
// 64. How I Make $50,000/Month on Skool (My Entire Funnel)
// 65. If You're Seeing This, You're About To Become Rich
// 66. 50 Lessons I Learned from Making $500,000+ on Skool (That Changed My Life)
// 67. How I Made $47,370 in 25 days with Skool (WITHOUT going viral)
// 68. How He Makes $100,000/Month on YouTube with a Podcast
// 69. How I Made $8,757 MRR and Got 47 New Clients in a Week on Skool
// 70. How I Make $1,000/Day on Skool.com (copy my exact strategy)
// 71. How I Grew 2 Million Subscribers and Made $57k in a month
// 72. 1 YT sub = $6.40 a month (how)
// 73. The truth the COURSE gurus will hate me for
// 74. $30M CEO Explains - How To Effortlessly Sell Your Products Online
// 75. Ultimate Pricing Guide: how to price your online course or coaching program
// PROPERLY
// 76. These sales tactics are UNETHICAL but almost everyone will buy if you use them
// 77. Simply how to SCALE a coaching business
// 78. Secret recording from a "millionaire-only" mastermind in Bali, please do not share
// 79. This is the universe sending you a sign to help you make more money
// 80. YouTube is BS, I give up
// 81. I usually charge $10,000 for this, but you can have it for free
// 82. Alex Hormozi Shows Me How to Scale to $300,000/Month (Private Live Call)
// 83. If you're struggling to get leads or sales calls, watch this
// 84. How to learn copywriting without courses or programs (NO BS)
// 85. When you "pull your energy back" the universe shifts in your favor
// 86. $2.4M of Prompt Engineering Hacks in 53 Mins (GPT, Claude)
// 87. 3 Simple Ways to Set up a RAG Chatbot (#1 Takes 90 Seconds)
// 88. How to Build a Website AI Agent in 13 Min (Free N8N Template)
// 89. How to Create Useful Voice Agents in 45 Mins (Step-By-Step)
// 90. YouTube Sucks for New AI Automation Agencies (Avoid This)
// 91. Step-by-Step: N8N Webhooks (From Beginner to Pro)
// 92. 59 Minutes of Straight AI Automation Advice ($2.3M Earned)
// 93. I Built An AI Agent That Automates Upwork ($500K+ Earned)
// 94. 9 Years of Business Advice in 63 Minutes (Copy These Steps)
// 95. How To Set Up N8N Self Hosting In 3 Minutes (6 Ways)
// 96. How to Build Better Automations ($2.3M Earned)
// 97. The N8N Instagram Parasite System (10K Followers In 15 Days)
// 98. The 9 Best Ways to Scrape Any Website in N8N
// 99. How to Systematize Your Business in Four Weeks (My Process)
// 100. I Built A $2,485 AI Proposal Generator In N8N (Copy This)
// 101. Why you're not getting any clients with AI automation
// 102. Every N8N JavaScript Function Explained (106 + 7 Extras)
// 103. How to Acquire Your First AI Automation Client For $0.00-$0.60
// 104. N8N Foundational Concepts (AI Agents, JSON, Logic)
// 105. The 3 Best AI Automation Agency Niches in 2025
// 106. N8N For Everyone (AI Agents, Workflows, & More)
// 107. 5 More Automations You Can Sell Today for $1,500 (Or $10,000)
// 108. Make.com vs N8N in 2025 (AI Agents, Key Features, & More)
// 109. The YouTube Parasite System (ChatGPT Growth Hack)
// 110. The Instagram → Facebook Custom Audience Scraper (5x ROI)
// 111. The Search Intent Email Scraping System (+15% Reply Rates)
// 112. 7 No BS Ways to Become More Productive in 2025 (+$129K/mo)
// 113. The 100% Automated Newsletter (ChatGPT + Make)
// 114. The LinkedIn Parasite System (Social Media AI Growth Hack)
// 115. My $919 YouTube Setup (That Made Me $503,829 This Year)
// 116. Beginner's Guide to Apify (Connect 1,000+ Websites)
// 117. 5 Unexpected Limitations of Make.com (& How to Solve Them)
// 118. How to Earn $10,000/Month As a Solo Freelancer (No Agency)
// 119. My Step-by-Step Automation Agency Delivery Process (Copy)
// 120. How To Scale Your Agency Without Adding Staff (+$100K/Mo)
// 121. How To Build An Automation Business In 30 Days For $396
// 122. The Ultimate Guide to Automation Pricing ($1M+ Earned)
// 123. 5 Automations You Can Sell Today For $1,500 To $10,000 (Copy)
// 124. 7 Make.com Automations That Make Me $200,000/Yr (Steal Them)
// 125. How This Infinite Content Idea Machine Scaled Me to 28K Subs
// 126. 3 ChatGPT Prompt Engineering Hacks You NEED to Start Using
// 127. The Future of Automation In 2025 (Prepare Now)
// 128. This Invoice Followup System Will Save You $1,000+ Per Month
// 129. How I Made $102,514 Last Month With Automation (Copy Me)
// 130. Make.com: Dates & Times Masterclass
// 131. The 9 Best Ways to Scrape Emails for Cold Outreach in 2024
// 132. How I Save 10,000 Make.com Operations/Day (Google Sheets Hack)
// 133. Learn Regex For Make.com In 34 Minutes
// 134. Watch Me Double Inbound Conversion Rate Using Make.com In 26 Min
// 135. How I Scrape Thousands of Local Business Emails In 15 Minutes
// 136. 5 Things I Wish I Knew About Automation Agencies Before I Started One
// 137. 48 Minutes of Clever Make.com Hacks That Save You Time & Money
// 138. How I Made Nearly $500,000 On Upwork With A Few Simple Tricks
// 139. The Definitive Make.com Web Scraping Masterclass
// 140. 4 Terrible Mistakes to Avoid When Delegating Your Automation Agency
// 141. How I Build Better Make.com Scenarios With Iterative Testing
// 142. The Definitive Make.com HTTP & API Masterclass
// 143. How To Service Your First AI Automation Agency Client In 2024 (Make.com)
// 144. The 3 Best Niches For AI Automation Agencies in 2024
// 145. 3 Common Automation Agency Mistakes You NEED To Avoid In 2024

// B. understand how to write the scripts - especially the hook:
// Key Takeaways from the Five Videos on YouTube Hooks & Scriptwriting
// 1. Understanding Hooks: The Psychology Behind Them
// ● Hooks are essential to video performance because they create a curiosity loop that
// compels viewers to continue watching.
// ● A strong hook must capture attention within the first 5 seconds or the audience will
// scroll away.
// ● The best-performing videos utilize contrast to create intrigue (e.g., setting up an
// expectation and then reversing it).
// ● Hooks should align spoken words, visuals, on-screen text, and audio for maximum
// impact.
// 2. The Three-Step Hook Formula
// A common hook structure used by top creators follows this three-step format:
// 1. Context Lean-In
// ○ Clearly state what the video is about (avoid misleading clickbait).
// ○ Establish common ground with the audience by referencing a benefit, pain
// point, or using a relatable metaphor.
// ○ Example: “The Vegas Sphere has the biggest screen ever built—20x bigger
// than IMAX.”
// 2. Scroll Stop Interjection
// ○ Use a contrasting word (e.g., "but," "however," "yet") to surprise the audience.
// ○ Example: “But get this—the screen is actually the least impressive part.”
// 3. Contrarian Snapback
// ○ Present an unexpected twist to deepen curiosity.
// ○ Example: “Because the most impressive part is actually the audio. This will
// blow your mind.”
// This formula works across all content types—short-form, long-form, B2B, educational, etc.
// 3. Six High-Performing Hook Formats
// A study of viral videos revealed that most hooks fall into these six categories:
// 1. The Fortune Teller
// ○ Predicts how something will change in the future.
// ○ Example: “This new technology is going to change home design forever.”
// ○ Works well for news, trends, product launches.
// 2. The Experimenter
// ○ Demonstrates an experiment or test.
// ○ Example: “I tried this new AI tool for a week—here’s what happened.”
// ○ Works well for product demos, case studies, and tutorials.
// 3. The Teacher
// ○ Provides a structured lesson.
// ○ Example: “Here’s how I scaled my YouTube channel from 0 to 1 million.”
// ○ Ideal for educational content and authority building.
// 4. The Magician
// ○ Uses visual or spoken "stun" tactics.
// ○ Example: “Check this out—this AI tool can do your work in seconds.”
// ○ Works well for highly visual, engaging videos.
// 5. The Investigator
// ○ Uncovers secrets or hidden insights.
// ○ Example: “This billionaire’s marketing strategy is hiding in plain sight.”
// ○ Great for storytelling, research-heavy content.
// 6. The Contrarian
// ○ Challenges conventional wisdom.
// ○ Example: “Everyone says you should do X, but that’s actually wrong. Here’s
// why.”
// ○ Works well for opinionated, thought leadership content.
// Each topic can be framed using multiple hook formats—choosing the right one depends on
// contrast and alignment with visuals.
// 4. Five-Part Hook Formula for YouTube
// Another video broke down a five-step formula for structuring a strong hook:
// 1. Reframe the Title – Reinforce that the video delivers on its promise.
// 2. Pain Points – Show the problem the viewer is experiencing.
// 3. Transition Line – Smoothly connect pain points to the solution.
// 4. Pleasure Points (After-State) – Tease the transformation the viewer will experience.
// 5. End Hook – A compelling closing statement to keep them watching.
// Example for a real estate video:
// ● “Are you tired of struggling with home financing?” (Pain Point)
// ● “In today’s video, I’ll show you a proven method to get the lowest mortgage rates.”
// (Transition)
// ● “So you can finally buy your dream home stress-free.” (After-State)
// 5. How to Align Hooks for Maximum Impact
// ● Start with a compelling visual – The audience processes visuals faster than words,
// so the first 3-5 seconds should have strong imagery.
// ● Overlay text on the screen – Use 3-5 words in bold font to reinforce the message.
// ● Use motion strategically – Too much motion is overwhelming; too little is boring.
// Example: The "Ray-Ban Meta Glasses" video used subtle head movements to
// maintain attention.
// The Golden Rule: First, identify the most interesting visual. Then, pick the hook format that
// best contrasts with it.
// 6. Call to Action (CTA) Strategies for Retention & Binge-Watching
// ● Instead of saying "Like and Subscribe" at the start, embed CTAs into the content.
// ● Create cliffhangers that lead into the next video. Example:
// 1. “We just covered why editing is key, but if nobody clicks on your video, it won’t
// matter. Watch this next video on crafting the perfect thumbnail.”
// ● Structure a CTA in three steps:
// 1. Subtle transition (tie back to an earlier point).
// 2. Create intrigue (introduce a new problem).
// 3. Direct them to the next video.
// 7. Writing the Script: Five-Step Framework
// 1. Packaging (Title & Idea)
// ○ The title must trigger curiosity while setting realistic expectations.
// ○ Example: “I Lived in a Pyramid for 100 Hours” (Expectation: Immersive
// experience).
// 2. Outline
// ○ Before writing, create a bullet-pointed structure to ensure each point is
// unique.
// 3. Intro (Hook + Curiosity Loop)
// ○ Follow the context-contrast-contrarian structure.
// 4. Body (Deliver on the Promise)
// ○ Keep expectation vs. reality in mind – aim to exceed expectations with
// valuable insights.
// 5. Outro (Retention Strategy)
// ○ Instead of just ending, lead viewers to another video to increase watch time.
// Final Summary: The Ultimate Hook & Scriptwriting Formula
// 1. Choose a strong hook format (Fortune Teller, Experimenter, Teacher, etc.).
// 2. Start with a visually compelling scene.
// 3. Align spoken, text, visual, and audio hooks for maximum comprehension.
// 4. Use curiosity loops to keep viewers engaged (each line should make them want the
// next).
// 5. Place value up front – give a quick win early to keep people watching.
// 6. Embed retention strategies – Use cliffhangers & seamless CTAs.
// Actionable Next Steps
// ● Experiment with different hook formats in your videos.
// ● Always lead with the most interesting visual.
// ● Structure scripts to layer curiosity and contrast.
// ● Use retention tactics (cliffhangers, structured CTAs) to keep people watching.
// ● A/B test different hooks to see what works best in your niche.

// C. Know more about the client - his landing page copy, youtube description, his youtube videos, competitor youtube videos,  first round of action plan we shared with the client, the pain points he chose out of all the ones we shared, notes from the first consultation call with the client.:
// {JSON}

// Go through everything and let's finalize:

// 1. video titles and a 2 line description that we will plan for the next 1 month
// 2. Create a content calendar for the same.
// 3. Include these topic of the videos as the client likes it:
// Learning curve of new AI tools and platforms.
// Overcoming creative blocks and generating fresh ideas.

// Please note that we are focusing on youtube for now.`;
export const TOPIC_USER_PROMPT = `
I want to generate high-performing YouTube video topics for my brand, {brandName}, which specializes in {niche}.
 My website, {website}, provides the following content:

My main competitors are {competitors}, and my target audience consists of {targetAudience}.

I have analyzed successful YouTube video topics that are currently trending within the {niche} niche, covering subjects like (mention key trends related to niche, e.g., app development, UI/UX design, digital marketing, automation, etc.). Based on my website’s content, services, and niche, please generate a list of YouTube video topics that will attract my target audience and position {brandName} as an authority in {niche}.

know what kind of titles are working  on youtube right now - they are from different niche. - just take inspirations and implement the same for our niche which is {niche}:
"How to Build a High-Performing Mobile App in 2024 – A Step-by-Step Guide"

1. My honest advice to someone who wants passive income
2. The Simplest Way to Start a One-Person Business Today!
3. How to Make $2,000 Each Week Starting Next Month
4. I Tried 7 Online Side Hustles, here's the BEST One [2025]
5. Want to Make ₹50,000 in 7 DAYS? Copy THIS
6. How I ACTUALLY Beat 5 Years of Procrastination
7. How I made ₹35,00,000 from YouTube (with 100 subscribers)
8. How I make time for Everything (the EASY way)
9. How I made ₹1,00,000/mo using "Law of Attraction"
10. How I Made ₹50,000 in 12 Hours so you can just COPY ME
11. The Bhagavad Gita’s SECRET to making MORE MONEY
12. How to go from broke to $23M a year in 21 mins
13. Watch this to scale your agency. [Agency Roadmap - FULL COURSE]
14. My Agency Made $23M in 2024. Here's How. [FULL BREAKDOWN]
15. THIS is why your agency will fail in 2025
16. I'm 36. If you are in your 20’s. Watch this.
17. Make $1M with your agency in 2025 (FULL BLUEPRINT)
18. EVERY $10K/m entrepreneur is LYING to YOU!
19. Make $10K a month in 2025 (starting now)
20. Make $100,000 working 3 days a week (was supposed to delete this)
21. Make $150,000 in 2025
22. If you're struggling to make money - watch this
23. The most PROFITABLE funnel training you'll ever watch (10,000 hours experience)
24. I Make $10K/month with This ONE Productivity Hack
25. Close $25K clients EASILY with this proven template

Ensure that the topics are engaging, follow viral trends in {niche}, and are optimized for maximum reach. The topics should align with my brand’s services, appeal to my audience, and differentiate {brandName} from its competitors.

here is Website Content:
'''{websiteContent}'''


`;
