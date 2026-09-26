import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Plus, X } from 'lucide-react';
import type { Project } from '../../../shared/types';
import type { DraftMapProject, MapHandle } from './ProjectMap';

type ProjectDraft = DraftMapProject & {
	description: string;
	startingDate: string;
	dueDate: string;
	totalCost: number;
};

type ProjectForm = {
	title: string;
	id: string;
	description: string;
	longitude: string;
	latitude: string;
	startingDate: string;
	dueDate: string;
	totalCost: string;
};

const emptyForm: ProjectForm = {
	title: '', id: '', description: '', longitude: '', latitude: '',
	startingDate: '', dueDate: '', totalCost: '',
};

type Props = { projects: Project[]; map: { current: MapHandle | null }; onConfirmed(project: Project): void };

export default function ProjectCreator({ projects, map, onConfirmed }: Props) {
	const [open, setOpen] = useState(false);
	const [stage, setStage] = useState<'form' | 'preview'>('form');
	const [form, setForm] = useState<ProjectForm>(emptyForm);
	const [draft, setDraft] = useState<ProjectDraft | null>(null);
	const [error, setError] = useState('');

	useEffect(() => {
		const markers = [...(open && stage === 'preview' && draft ? [draft] : [])]
			.map(({ id, title, coordinates }) => ({ id, title, coordinates }));
		map.current?.setDraftProjects(markers);
	}, [draft, map, open, stage]);

	useEffect(() => {
		if (open && stage === 'preview' && draft) map.current?.focusCoordinate(draft.coordinates);
	}, [draft?.id, map, open, stage]);

	const cancel = () => {
		setOpen(false);
		setStage('form');
		setForm(emptyForm);
		setDraft(null);
		setError('');
	};

	const savePreview = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const id = form.id.trim();
		const longitude = Number(form.longitude);
		const latitude = Number(form.latitude);
		const totalCost = Number(form.totalCost);

		if (projects.some(project => project.id.toLowerCase() === id.toLowerCase())) {
			setError('That project ID is already in use.');
			return;
		}
		if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
			setError('Enter valid coordinates: longitude from -180 to 180 and latitude from -90 to 90.');
			return;
		}
		if (form.dueDate < form.startingDate) {
			setError('Due date must be on or after the starting date.');
			return;
		}
		if (!Number.isFinite(totalCost) || totalCost < 0) {
			setError('Enter a valid non-negative total cost.');
			return;
		}

		setDraft({
			id,
			title: form.title.trim(),
			description: form.description.trim(),
			coordinates: [longitude, latitude],
			startingDate: form.startingDate,
			dueDate: form.dueDate,
			totalCost,
		});
		setError('');
		setStage('preview');
	};

	const confirm = () => {
		if (!draft) return;
		const [longitude, latitude] = draft.coordinates;
		const project: Project = {
			id: draft.id,
			utility: 'GPC',
			state: '',
			name: draft.title,
			shortName: draft.title,
			endpoints: [
				{ name: 'Project location', coordinates: [longitude, latitude] },
				{ name: 'Project location', coordinates: [longitude, latitude] },
			],
			inServiceDate: draft.dueDate || null,
			rawDate: draft.dueDate,
			sourceRow: 0,
			sourceProjectId: draft.id,
			document: null,
			documentPage: null,
			notes: [draft.description, `Starting date: ${draft.startingDate}`, `Total cost: ${draft.totalCost}`],
		};
		cancel();
		onConfirmed(project);
	};

	return <>
		<button className="create-project-trigger" onClick={() => { setOpen(true); setStage('form'); setError(''); }}>
			<Plus size={16}/>Create New Project
		</button>
		{open && <div className={`project-wizard-backdrop ${stage === 'preview' ? 'is-preview' : ''}`}>
			<section className={`project-wizard ${stage === 'preview' ? 'preview-stage' : ''}`} role="dialog" aria-modal={stage === 'form'} aria-labelledby="project-wizard-title">
				<div className="project-wizard-heading">
					<div><span className="eyebrow">NEW PROJECT · {stage === 'form' ? '1 OF 2' : '2 OF 2'}</span><h2 id="project-wizard-title">{stage === 'form' ? 'Project details' : 'Review map location'}</h2></div>
					<button type="button" className="icon-button" aria-label="Cancel project creation" onClick={cancel}><X size={17}/></button>
				</div>
				{stage === 'form' ? <form className="project-form" onSubmit={savePreview}>
					<label>Project Title<input required maxLength={120} value={form.title} onChange={event => setForm(current => ({ ...current, title: event.target.value }))}/></label>
					<label>Project ID<input required maxLength={80} value={form.id} onChange={event => setForm(current => ({ ...current, id: event.target.value }))}/></label>
					<label>Project Description<textarea required rows={3} maxLength={1000} value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))}/></label>
					<fieldset><legend>Location (Coordinates)</legend>
						<label>Longitude<input required type="number" min="-180" max="180" step="any" value={form.longitude} onChange={event => setForm(current => ({ ...current, longitude: event.target.value }))}/></label>
						<label>Latitude<input required type="number" min="-90" max="90" step="any" value={form.latitude} onChange={event => setForm(current => ({ ...current, latitude: event.target.value }))}/></label>
					</fieldset>
					<fieldset><legend>Project dates</legend>
						<label>Starting Date<input required type="date" value={form.startingDate} onChange={event => setForm(current => ({ ...current, startingDate: event.target.value }))}/></label>
						<label>Due Date<input required type="date" min={form.startingDate || undefined} value={form.dueDate} onChange={event => setForm(current => ({ ...current, dueDate: event.target.value }))}/></label>
					</fieldset>
					<label>Total Cost<input required type="number" min="0" step="0.01" inputMode="decimal" value={form.totalCost} onChange={event => setForm(current => ({ ...current, totalCost: event.target.value }))}/></label>
					{error && <p className="project-form-error" role="alert">{error}</p>}
					<div className="project-wizard-actions"><button type="button" className="secondary-button" onClick={cancel}>Cancel</button><button type="submit" className="primary-button">Save &amp; preview <ArrowRight size={15}/></button></div>
				</form> : <div className="project-preview-content">
					<p className="preview-intro">Click an existing project marker to inspect its details in the side panel. The new project marker stays at these coordinates.</p>
					<dl>
						<dt>Project</dt><dd>{draft?.title} <span>({draft?.id})</span></dd>
						<dt>Coordinates</dt><dd>{draft?.coordinates[1].toFixed(5)}, {draft?.coordinates[0].toFixed(5)} <span>latitude, longitude</span></dd>
						<dt>Dates</dt><dd>{draft?.startingDate} to {draft?.dueDate}</dd>
						<dt>Total cost</dt><dd>{draft?.totalCost.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}</dd>
					</dl>
					<div className="project-wizard-actions"><button type="button" className="secondary-button" onClick={() => setStage('form')}>Back to editing</button><button type="button" className="primary-button" onClick={confirm}><Check size={15}/>Confirm project</button></div>
				</div>}
			</section>
		</div>}
	</>;
}
