#!/usr/bin/env node

/**
 * build-cv-awesome.mjs — Build a CV in Awesome-CV format from the JSON payload.
 *
 * Replaces the existing build-cv-latex.mjs (which uses \resumeSubheading etc.).
 * This builder uses Awesome-CV's \cvsection, \cventry, \cvskill, \cvitems.
 *
 * Usage:
 *   node build-cv-awesome.mjs <input.json> <output.tex>
 *
 * Output .tex is a valid Awesome-CV document that compiles with xelatotonic
 * (XeTeX engine). The caller must supply the surrounding template (header,
 * \fontdir, fonts/ directory, awesome-cv.cls, fontawesome.sty).
 *
 * The .tex uses placeholders {{PLACEHOLDER}} for the template engine.
 * The JSON payload uses the same structure as the current pipeline:
 *   {
 *     candidate: { name, email, phone, location, linkedin, github, ... },
 *     experience: [{ company, role, dates, location, bullets: [] }],
 *     education: [{ institution, degree, dates, location }],
 *     projects: [{ name, context, dates, url, bullets: [] }],
 *     skills: [{ category, items: [] }]
 *   }
 */

import { readFile, writeFile, stat, copyFile, cp } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';
import { escapeLatex, sanitizeUrl } from './lib/latex-escape.mjs';
import { hasRequiredFields, hasText, validatePayload } from './lib/cv-payload-schema.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MARKDOWN_BOLD_RE = /\*\*([^*]+?)\*\*/g;

function escapeBullet(text) {
  return escapeLatex(text).replace(MARKDOWN_BOLD_RE, (_, inner) => `\\textbf{${inner}}`);
}

/**
 * Build Skills section content for Awesome-CV format.
 * Renders as a tabular inside \cventry, one row per category.
 *
 * @param {Array<object>} categories
 * @returns {string} tabular rows or empty
 */
function buildSkills(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  const rows = categories
    .map(c => {
      if (!hasRequiredFields(c, 'skills', 'tex')) return '';
      if (!hasText(c.category)) return '';
      const items = Array.isArray(c.items) ? c.items.join(', ') : (c.items || '');
      return `${escapeLatex(c.category)}:  & {\\skill{${escapeLatex(items)}}} \\\\`;
    })
    .filter(Boolean);
  return rows.join('\n\t');
}

/**
 * Build Experience entries using Awesome-CV \cventry.
 *
 * @param {Array<object>} entries
 * @returns {string} LaTeX \cventry blocks or empty
 */
function buildExperience(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries
    .map(e => {
      if (!hasRequiredFields(e, 'experience', 'tex')) return '';
      const position = escapeLatex(e.role || e.title || '');
      const company = escapeLatex(e.company || '');
      const location = escapeLatex(e.location || '');
      const dates = escapeLatex((e.dates ?? '') || ((e.startDate ?? '') + (e.endDate ? ' – ' + e.endDate : '')));
      const bullets = (Array.isArray(e.bullets) ? e.bullets : [])
        .map(b => `		\\item{${escapeBullet(b)}}`)
        .join('\n');
      const description = bullets
        ? `\\begin{cvitems}\n${bullets}\n\t\\end{cvitems}`
        : '{}';
      return `\t\\cventry
	{${position}}
	{${company}}
	{${location}}
	{${dates}}
	{${description}}`;
    })
    .join('\n\n');
}

/**
 * Build Project entries using Awesome-CV \cventry.
 * Projects have empty position (first arg), tech in location, empty date.
 *
 * @param {Array<object>} entries
 * @returns {string} LaTeX \cventry blocks or empty
 */
function buildProjects(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries
    .map(e => {
      if (!hasRequiredFields(e, 'projects', 'tex')) return '';
      const name = escapeLatex(e.name || '');
      const context = e.context ? ` \\emph{$|$ ${escapeLatex(e.context)}}` : '';
      const url = sanitizeUrl(e.url);
      const nameFormatted = url
        ? `\\href{${escapeLatex(url, 'url')}}{\\textbf{${name}}}${context}`
        : `\\textbf{${name}}${context}`;
      const tech = escapeLatex(e.tech || e.context || '');
      const dates = escapeLatex((e.dates ?? '') || ((e.startDate ?? '') + (e.endDate ? ' – ' + e.endDate : '')));
      const bullets = (Array.isArray(e.bullets) ? e.bullets : [])
        .map(b => `		\\item{${escapeBullet(b)}}`)
        .join('\n');
      const description = bullets
        ? `\\begin{cvsectionnormaltext}\n${bullets}\n\t\\end{cvsectionnormaltext}`
        : '{}';
      return `\t\\cventry
	{}
	{${nameFormatted}}
	{${tech}}
	{${dates}}
	{${description}}`;
    })
    .join('\n\n');
}

/**
 * Build Education entries using Awesome-CV \cventry.
 * Education: position empty, institution as title, location as location.
 *
 * @param {Array<object>} entries
 * @returns {string} LaTeX \cventry blocks or empty
 */
function buildEducation(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries
    .map(e => {
      if (!hasRequiredFields(e, 'education', 'tex')) return '';
      const institution = escapeLatex(e.institution || '');
      const location = escapeLatex(e.location || '');
      const dates = escapeLatex((e.dates ?? '') || ((e.startDate ?? '') + (e.endDate ? ' – ' + e.endDate : '')));
      const degree = escapeLatex(e.degree || '');
      const coursework = e.coursework ? `\\begin{cvsectionnormaltext}
\t\t\\item{${escapeBullet(degree)}}
\t\t${(Array.isArray(e.coursework) && e.coursework.length > 0)
          ? '\\item{\\textbf{Coursework:} ' + escapeBullet(e.coursework.join(', ')) + '}'
          : ''}
\t\\end{cvsectionnormaltext}` : `\\begin{cvsectionnormaltext}
\t\t\\item{${escapeBullet(degree)}}
\t\\end{cvsectionnormaltext}`;
      return `\t\\cventry
	{}
	{${institution}}
	{${location}}
	{${dates}}
	{${coursework}}`;
    })
    .join('\n\n');
}

/**
 * Build header contact line from payload.
 *
 * @param {object} candidate
 * @returns {{name_first: string, name_last: string, email: string, phone: string, location: string, linkedin_display: string, linkedin_url: string, github_display: string, github_url: string}}
 */
function buildHeader(candidate) {
  const name = (candidate.name || candidate.full_name || '').trim();
  const parts = name.split(/\s+/);
  const name_first = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
  const name_last = parts.length > 1 ? parts[parts.length - 1] : '';

  const email = escapeLatex(candidate.email || '');
  const phone = escapeLatex(candidate.phone || '');
  const location = escapeLatex(candidate.location || '');

  const linkedin = escapeLatex(candidate.linkedin || '');
  const linkedin_display = hasText(candidate.linkedin_display || linkedin)
    ? escapeLatex(candidate.linkedin_display || linkedin)
    : '';
  const linkedin_url = linkedin ? sanitizeUrl(`https://linkedin.com/in/${linkedin}`) : 'javascript:void(0)';

  const github = escapeLatex(candidate.github || '');
  const github_display = hasText(candidate.github_display || github)
    ? escapeLatex(candidate.github_display || github)
    : '';
  const github_url = github ? sanitizeUrl(`https://github.com/${github}`) : 'javascript:void(0)';

  return { name_first, name_last, email, phone, location, linkedin_display, linkedin_url, github_display, github_url };
}

async function main() {
  const args = process.argv.slice(2);

  const inputPath = args[0];
  const outputPath = args[1];

  if (!inputPath || !outputPath) {
    console.error('Usage: node build-cv-awesome.mjs <input.json> <output.tex>');
    process.exit(1);
  }

  // Read and validate the payload
  let payload;
  try {
    const raw = await readFile(inputPath, 'utf-8');
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading/parsing ${inputPath}: ${err.message}`);
    process.exit(1);
  }

  const errors = validatePayload(payload, 'tex');
  if (errors.length > 0) {
    console.error(`Payload validation errors: ${errors.join(', ')}`);
    process.exit(1);
  }

  // Build all sections
  const header = buildHeader(payload.candidate || {});
  const skillsContent = buildSkills(payload.skills || []);
  const experienceContent = buildExperience(payload.experience || []);
  const projectsContent = buildProjects(payload.projects || []);
  const educationContent = buildEducation(payload.education || []);

  // Substitute into the template
  let template;
  try {
    template = await readFile(join(__dirname, 'templates', 'awesome-cv', 'resume.tex'), 'utf-8');
  } catch (err) {
    console.error(`Template not found: ${join(__dirname, 'templates', 'awesome-cv', 'resume.tex')}`);
    process.exit(1);
  }

  const tex = template
    .replace('{{NAME_FIRST}}', '{' + header.name_first + '}')
    .replace('{{NAME_LAST}}', '{' + header.name_last + '}')
    .replace('{{EMAIL}}', header.email)
    .replace('{{PHONE}}', header.phone)
    .replace('{{LOCATION}}', header.location)
    .replace('{{LINKEDIN_URL}}', header.linkedin_url)
    .replace('{{LINKEDIN_DISPLAY}}', header.linkedin_display)
    .replace('{{GITHUB_URL}}', header.github_url)
    .replace('{{GITHUB_DISPLAY}}', header.github_display)
    .replace('{{SKILLS_TABULAR}}', skillsContent)
    .replace('{{EXPERIENCE_CVENTRY}}', experienceContent)
    .replace('{{PROJECTS_CVENTRY}}', projectsContent)
    .replace('{{EDUCATION_CVENTRY}}', educationContent);

  // Copy dependencies to the same directory as the output .tex file
  const depsDir = dirname(outputPath);
  const templateDir = join(__dirname, 'templates', 'awesome-cv');
  const depsToCopy = ['awesome-cv.cls', 'fontawesome.sty', 'fonts'];
  for (const dep of depsToCopy) {
    const src = join(templateDir, dep);
    const dst = join(depsDir, dep);
    if (!existsSync(dst)) {
      if (dep.endsWith('.cls') || dep.endsWith('.sty')) {
        await copyFile(src, dst);
      } else {
        // Copy directory recursively
        await cp(src, dst, { recursive: true });
      }
    }
  }

  // Write output
  try {
    await writeFile(outputPath, tex, 'utf-8');
    console.log(JSON.stringify({
      output: outputPath,
      sections: {
        skills: !!skillsContent,
        experience: !!experienceContent,
        projects: !!projectsContent,
        education: !!educationContent,
      },
    }));
  } catch (err) {
    console.error(`Error writing ${outputPath}: ${err.message}`);
    process.exit(1);
  }
}

main();
