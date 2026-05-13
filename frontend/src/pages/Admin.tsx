import { useEffect, useState } from "react";
import { api } from "../api";

export function Admin() {
  const [users, setUsers] = useState<any[]>([]);
  const [form, setForm] = useState({ username: "", password: "", role: "student", maxVms: 1, allowedTemplates: "*" });
  const load = async () => setUsers(await api.adminUsers());
  useEffect(() => { load(); }, []);

  return <div className="content"><h1>Admin: Users</h1>
    <div className="session-row" style={{gridTemplateColumns:"1fr 1fr 120px 120px"}}>
      <input placeholder="username" value={form.username} onChange={(e)=>setForm({...form, username:e.target.value})}/>
      <input placeholder="password" type="password" value={form.password} onChange={(e)=>setForm({...form, password:e.target.value})}/>
      <input placeholder="max VMs" type="number" value={form.maxVms} onChange={(e)=>setForm({...form, maxVms:Number(e.target.value)})}/>
      <input placeholder="templates (* or csv)" value={form.allowedTemplates} onChange={(e)=>setForm({...form, allowedTemplates:e.target.value})}/>
      <button onClick={async()=>{await api.createUser(form); setForm({...form, username:"", password:""}); await load();}}>Add user</button>
    </div>
    {users.map((u)=><div key={u.id} className="session-row"><div>{u.username}</div><div>{u.role}</div><div>{u.max_vms}</div><div>{u.allowed_templates}</div></div>)}
  </div>;
}
