import { useCallback, useEffect, useRef, useState } from 'react';
import type { Demo, Project } from '../types';
import { api } from './api';
import { demoProject } from './editor';
const KEY='cutline.projects.v1';
function readLibrary():Project[]{
  try { const value=JSON.parse(localStorage.getItem(KEY)||'[]');if(!Array.isArray(value))return[];return value.filter(p=>p&&typeof p.id==='string'&&typeof p.name==='string'&&p.asset&&typeof p.asset.id==='string'&&typeof p.asset.url==='string'&&Number.isFinite(p.asset.duration)&&p.asset.duration>0&&p.settings&&Number.isFinite(p.settings.start)&&Number.isFinite(p.settings.end)&&Array.isArray(p.captions)&&Array.isArray(p.clips)&&Array.isArray(p.heatmap)).slice(0,30); }catch{return[];}
}
export function useStudio(){
  const [library,setLibrary]=useState<Project[]>(readLibrary);
  const [project,setProject]=useState<Project|null>(()=>{let active='';try{active=localStorage.getItem('cutline.active')||'';}catch{/* Storage is optional. */}return library.find(p=>p.id===active)||library[0]||null;});
  const [demo,setDemo]=useState<Demo|null>(null);const [loadError,setLoadError]=useState('');const [saved,setSaved]=useState(true);
  const current=useRef(project);current.current=project;
  const undoStack=useRef<Project[]>([]);const redoStack=useRef<Project[]>([]);const [,refreshHistory]=useState(0);
  useEffect(()=>{const controller=new AbortController();void api<Demo>('/api/demo',undefined,controller.signal).then(data=>{setDemo(data);if(!current.current){const p=demoProject(data);current.current=p;setProject(p);}}).catch(e=>{if((e as Error).name!=='AbortError')setLoadError((e as Error).message);});return()=>controller.abort();},[]);
  useEffect(()=>{if(!project)return;setLibrary(list=>{const next=[project,...list.filter(p=>p.id!==project.id)].slice(0,30);try{localStorage.setItem(KEY,JSON.stringify(next));localStorage.setItem('cutline.active',project.id);setSaved(true);}catch{setSaved(false);}return next;});},[project]);
  const edit=useCallback((change:(p:Project)=>Project)=>{const prior=current.current;if(!prior)return;const next={...change(prior),updatedAt:new Date().toISOString()};undoStack.current.push(prior);if(undoStack.current.length>40)undoStack.current.shift();redoStack.current=[];current.current=next;setProject(next);},[]);
  const open=useCallback((p:Project)=>{undoStack.current=[];redoStack.current=[];current.current=p;setProject(p);refreshHistory(n=>n+1);},[]);
  const undo=useCallback(()=>{const prior=undoStack.current.pop();if(prior&&current.current){redoStack.current.push(current.current);current.current=prior;setProject(prior);}},[]);
  const redo=useCallback(()=>{const next=redoStack.current.pop();if(next&&current.current){undoStack.current.push(current.current);current.current=next;setProject(next);}},[]);
  const remove=useCallback((id:string)=>{setLibrary(list=>{const next=list.filter(p=>p.id!==id);try{localStorage.setItem(KEY,JSON.stringify(next));}catch{setSaved(false);}return next;});},[]);
  return{project,library,demo,loadError,saved,current,edit,open,undo,redo,remove,canUndo:undoStack.current.length>0,canRedo:redoStack.current.length>0};
}
